#!/usr/bin/env python3
"""Actual Android Pi/process/MCP acceptance against an already installed isolated APK."""
import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
import shlex
import subprocess
import sys
import time
from urllib.parse import urlencode
from urllib.request import urlopen
import uuid
from android_reports import read_reports

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True, help='Dedicated test package; never use user Arxd data')
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--storage-faults', action='store_true', help='Deny writes to owned registry/log paths, then restore them')
    parser.add_argument('--checkpoints', action='store_true', help='Kill/reopen at durable intent/spawn/result/stdin/MCP effects')
    parser.add_argument('--background-seconds', type=int, default=60, help='0 skips sustained background/lockscreen observation')
    parser.add_argument('--service-safety', action='store_true', help='Run public process bounds and real credential/ownership/native binding regressions')
    parser.add_argument('--external-http-host', help='Owned RFC1918 host interface reachable directly by the phone; no ADB reverse')
    parser.add_argument('--external-http-only', action='store_true', help='Run only the bounded LAN policy/Pi acceptance; requires --external-http-host')
    parser.add_argument('--native-mcp', action='store_true', help='Reuse existing independent native protocol matrix')
    parser.add_argument('--native-mcp-background', action='store_true', help='Also prove native stdio response completion while locked and JavaScript is held')
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--background-only', action='store_true', help='Only run existing sustained HTTP background/lockscreen acceptance (60s by default)')
    selection.add_argument('--native-mcp-only', action='store_true', help='Only run the existing native MCP/TLS matrix; requires --native-mcp or --native-mcp-background')
    args = parser.parse_args()
    if not args.package.startswith('art.tsingshui.arxd.') or not 0 <= args.background_seconds <= 600:
        parser.error('Use an isolated package and 0–600 background seconds')
    if args.background_only or args.native_mcp_only:
        if args.storage_faults or args.checkpoints or args.service_safety or args.external_http_host or args.external_http_only:
            parser.error('Single-stage selectors cannot be combined with storage, checkpoints, safety or external HTTP flags')
    if args.background_only and (args.native_mcp or args.native_mcp_background or args.background_seconds == 0):
        parser.error('--background-only requires positive --background-seconds and no native MCP flags')
    if args.native_mcp_only and not (args.native_mcp or args.native_mcp_background):
        parser.error('--native-mcp-only requires --native-mcp or --native-mcp-background')
    if args.external_http_only and not args.external_http_host:
        parser.error('--external-http-only requires --external-http-host')
    if args.external_http_host:
        try:
            host = ipaddress.IPv4Address(args.external_http_host)
            assert any(host in ipaddress.ip_network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
        except (ValueError, AssertionError):
            parser.error('--external-http-host must be an explicit owned RFC1918 IPv4 interface')
    run = uuid.uuid4().hex[:16]
    directory = ROOT / 'target/arxd/services-evidence' / run
    directory.mkdir(parents=True)
    scope = 'background-only' if args.background_only else 'native-mcp-only' if args.native_mcp_only else 'selected-services'
    proof = {'verified': False, 'scope': scope, 'run': run, 'package': args.package, 'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'mode': 'offline-deterministic/real-android-pi-process-mcp', 'checkpoints': []}

    def adb(*command, binary=False, timeout=90):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=timeout)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def launch(profile, stage='run', **params):
        params.update(run=run, case=profile, stage=stage)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://verify-services?' + urlencode(params)), '-n', args.package + '/.MainActivity')

    app_uid = None

    def log_uid():
        nonlocal app_uid
        if app_uid is None:
            user = adb('shell', 'am', 'get-current-user').strip()
            assert user.isdigit(), 'Cannot identify the Android user for isolated package logs'
            packages = adb('shell', 'pm', 'list', 'packages', '-U', '--user', user, args.package)
            matches = re.findall(r'^package:' + re.escape(args.package) + r' uid:(\d+)$', packages, re.M)
            assert len(matches) == 1 and int(matches[0]) >= 10000, 'Cannot prove the isolated App UID; no logs read'
            app_uid = int(matches[0])
            proof['logIdentity'] = {'package': args.package, 'user': int(user), 'uid': app_uid}
        return app_uid

    def host_pid(timeout=90, required=True):
        # A native fork can briefly inherit the App name before exec. Only
        # ActivityManager's attached Java host is authoritative, never pidof order.
        dump = adb('shell', 'dumpsys', 'activity', 'activities', args.package, timeout=timeout)
        (directory / 'latest-host-activities.txt').write_text(dump)
        pids = set(re.findall(r'^\s*app=ProcessRecord\{[^\s}]+\s+(\d+):' + re.escape(args.package) + r'/[^\s}]+\}', dump, re.M))
        if not pids and not required: return ''
        assert len(pids) == 1, 'Expected one ActivityManager-attached isolated App host: ' + str(sorted(pids))
        pid = next(iter(pids))
        assert int(pid) > 1, 'Invalid isolated App host PID'
        return pid

    def records():
        uid = log_uid()
        pid = host_pid(required=False)
        if not pid:
            return []
        # UID forbids foreign-package logs; current host PID also excludes stale
        # no-run native reports from previous App processes and transient children.
        text = adb('logcat', '-d', '--uid=' + str(uid), '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S')
        (directory / 'latest-logcat.txt').write_text(text)
        return read_reports(text)

    def report(event, profile=None, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for item in reversed(records()):
                if item.get('run') not in (None, run):
                    continue
                if item.get('event') == 'arxd-services-failed':
                    raise AssertionError(item)
                if item.get('event') == event and (profile is None or item.get('profile') == profile):
                    return item
            time.sleep(.35)
        raise AssertionError('Missing actual Android report: ' + str((event, profile)))

    def activity_identity(timeout=90):
        dump = adb('shell', 'dumpsys', 'activity', 'activities', timeout=timeout)
        identities = set(re.findall(r'ActivityRecord\{([^\s}]+)\s+u[0-9]+\s+' + re.escape(args.package) + r'/\.MainActivity\b', dump))
        assert len(identities) == 1, 'Expected one existing target MainActivity, never an unrelated Activity'
        return next(iter(identities))

    def observed_lock(label, timeout=10):
        # A sent sleep key event is not evidence of keyguard or actual sleep.
        # Retain raw observations and their request brackets on failed runs too.
        deadline = time.monotonic() + timeout
        sample = {'label': label, 'hostMonotonic': time.monotonic()}
        power = adb('shell', 'dumpsys', 'power', timeout=max(.01, deadline - time.monotonic()))
        keyguard = adb('shell', 'dumpsys', 'window', 'policy', timeout=max(.01, deadline - time.monotonic()))
        sample.update(powerAsleep=bool(re.search(r'mWakefulness=(Asleep|Dozing)', power)),
                      keyguardShowing=bool(re.search(r'\b(?:showing|isKeyguardShowing|mShowingLockscreen)\s*[=:]\s*true', keyguard)),
                      finishedHostMonotonic=time.monotonic())
        prefix = directory / label
        prefix.with_suffix('.power.txt').write_text(power)
        prefix.with_suffix('.keyguard.txt').write_text(keyguard)
        proof.setdefault('lockedSamples', []).append(sample)
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        return sample

    def require_locked(label):
        sample = observed_lock(label)
        assert sample['powerAsleep'] and sample['keyguardShowing'], 'Expected actual sleep and showing keyguard throughout the sampled interval: ' + label
        return sample

    native_background = None
    physical_unlock_expired = False

    def wait_for_physical_unlock(phase):
        nonlocal physical_unlock_expired
        adb('shell', 'input', 'keyevent', '224', timeout=15)
        deadline = time.monotonic() + (0 if physical_unlock_expired else 120)
        blocked_at = None
        entry = None
        while True:
            timeout = 5 if physical_unlock_expired else max(.01, min(5, deadline - time.monotonic()))
            if native_background:
                assert host_pid(timeout=timeout) == native_background['pid'], 'Pending native host changed while waiting for physical unlock'
                assert activity_identity(timeout=timeout) == native_background['activity'], 'Pending native Activity changed while waiting for physical unlock'
            policy = adb('shell', 'dumpsys', 'window', 'policy', timeout=timeout)
            (directory / 'physical-unlock-policy.txt').write_text(policy)
            showing = re.findall(r'\b(?:showing|isKeyguardShowing|mShowingLockscreen)\s*[=:]\s*(true|false)', policy)
            assert showing, 'Cannot observe actual keyguard state; no UI launch attempted'
            if 'true' not in showing:
                proof['requiresPhysicalUserUnlock'] = False
                if entry:
                    entry.update(verifiedUnlocked=True, unlockedHostMonotonic=time.monotonic())
                    (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
                physical_unlock_expired = False
                return time.monotonic() - blocked_at if blocked_at is not None else 0
            if entry is None:
                blocked_at = time.monotonic()
                entry = {'phase': phase, 'verifiedUnlocked': False, 'secure': bool(re.search(r'\b(?:secure|mSecure|isSecure)\s*[=:]\s*true', policy)), 'startedHostMonotonic': blocked_at, 'timeoutSeconds': 0 if physical_unlock_expired else 120}
                proof.setdefault('physicalUnlockWaits', []).append(entry)
                proof['requiresPhysicalUserUnlock'] = True
                print(json.dumps({'event': 'physical-unlock-needed', 'package': args.package, **entry}), flush=True)
            if time.monotonic() >= deadline:
                physical_unlock_expired = True
                entry['expired'] = True
                (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
                raise AssertionError('Physical user unlock is required; bounded wait expired without launching UI or changing lock security')
            (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
            time.sleep(min(1, max(0, deadline - time.monotonic())))

    def resume_native_activity(phase):
        wait_for_physical_unlock(phase)
        deadline = time.monotonic() + 15
        observations = proof.setdefault('nativeMcpResumeObservations', [])

        def bounded_adb(*command):
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'Same-Activity foreground recovery exceeded 15 seconds'
            return adb(*command, timeout=remaining)

        def verify_identity():
            assert host_pid(timeout=max(.01, deadline - time.monotonic())) == native_background['pid'], 'Pending native host no longer exists'
            assert activity_identity(timeout=max(.01, deadline - time.monotonic())) == native_background['activity'], 'Pending native Activity no longer exists'

        verify_identity()
        foreground_requested = False
        while time.monotonic() < deadline:
            power = bounded_adb('shell', 'dumpsys', 'power')
            dreams = bounded_adb('shell', 'dumpsys', 'dreams')
            activities = bounded_adb('shell', 'dumpsys', 'activity', 'activities')
            top = re.findall(r'topResumedActivity\s*[:=]\s*ActivityRecord\{[^}]*?\su[0-9]+\s+([^\s}]+)', activities)
            if not top:
                top = re.findall(r'mResumedActivity\s*[:=]\s*ActivityRecord\{[^}]*?\su[0-9]+\s+([^\s}]+)', activities)
            dreaming = bool(re.search(r'mWakefulness=Dreaming|mIsDreaming\s*[=:]\s*true', power + '\n' + dreams) or any('DreamActivity' in component for component in top))
            awake = bool(re.search(r'mWakefulness=Awake', power))
            entry = {'phase': phase, 'hostMonotonic': time.monotonic(), 'dreamActive': dreaming, 'powerAwake': awake, 'topActivities': top}
            observations.append(entry)
            prefix = directory / f'native-resume-{len(observations)}'
            prefix.with_suffix('.power.txt').write_text(power)
            prefix.with_suffix('.dreams.txt').write_text(dreams)
            prefix.with_suffix('.activities.txt').write_text(activities)
            (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
            # Dismiss only an observed active screensaver, without changing its
            # configuration, charging behavior, lock policy or security settings.
            if dreaming:
                try:
                    output = bounded_adb('shell', 'cmd', 'dreams', 'stop-dreaming')
                    if re.search(r'SecurityException|Must be ROOT|Permission denied', output, re.IGNORECASE):
                        raise RuntimeError(output[:1024])
                except RuntimeError as error:
                    entry['shellStopDreamError'] = str(error)[:1024]
                    if not re.search(r'SecurityException|Must be ROOT|Permission denied', str(error), re.IGNORECASE):
                        raise  # Unknown command/transport failures do not authorize root fallback.
                    # Some Android builds restrict this transient operation to
                    # root. Use only existing ADB su access; never grant it.
                    try:
                        output = bounded_adb('shell', 'su', '-c', shlex.quote('cmd dreams stop-dreaming'))
                        if re.search(r'SecurityException|Must be ROOT|Permission denied', output, re.IGNORECASE):
                            raise RuntimeError(output[:1024])
                        entry['stopDreamUsedExistingAdbRoot'] = True
                    except Exception as root_error:
                        raise RuntimeError('Observed Dream could not be dismissed with existing ADB permissions: ' + str(root_error)) from root_error
                entry['stopDreamRequested'] = True
            if not foreground_requested or dreaming or not awake or not top or any(component not in (args.package + '/.MainActivity', args.package + '/' + args.package + '.MainActivity') for component in top):
                deadline += wait_for_physical_unlock(phase)
                verify_identity()
                bounded_adb('shell', 'am', 'start', '-W', '--activity-reorder-to-front', '--activity-single-top', '-n', args.package + '/.MainActivity')
                entry['returnRequested'] = True
                foreground_requested = True
            else:
                verify_identity()
                return
            time.sleep(min(.2, max(0, deadline - time.monotonic())))
        raise AssertionError('Captured native Activity did not become top within 15 seconds')

    external = None
    lan_fixture = None
    tls_fixture = None
    forwarded = []
    reversed_ports = []
    locked = False
    try:
        installed = adb('shell', 'pm', 'path', args.package).splitlines()
        assert len(installed) == 1 and installed[0].startswith('package:'), 'Expected one installed acceptance APK'
        installed_hash = adb('shell', 'sha256sum', shlex.quote(installed[0].removeprefix('package:'))).split()[0]
        assert installed_hash == proof['apkSha256'], 'Supplied APK differs from the actual installed package'
        proof['installedApkSha256'] = installed_hash
        proof['device'] = {key: adb('shell', 'getprop', prop).strip() for key, prop in [('model', 'ro.product.model'), ('os', 'ro.build.version.release'), ('sdk', 'ro.build.version.sdk'), ('abi', 'ro.product.cpu.abi')]}
        # Dedicated test package only: required user-visible foreground notification.
        adb('shell', 'pm', 'grant', args.package, 'android.permission.POST_NOTIFICATIONS')
        adb('shell', 'am', 'force-stop', args.package)
        if args.external_http_host:
            lan_directory = directory / 'external-lan-mcp'
            lan_fixture = subprocess.Popen([sys.executable, str(ROOT / 'native/services/mcp-fixture.py'), 'http', str(lan_directory), '--bind-host', args.external_http_host], stdout=subprocess.DEVNULL, stderr=(directory / 'external-lan-mcp.log').open('wb'))
            deadline = time.monotonic() + 10
            while not (lan_directory / 'port').exists():
                if lan_fixture.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError('Owned LAN fixture could not bind/start; no network policy or routing was changed')
                time.sleep(.05)
            url = f'http://{args.external_http_host}:{int((lan_directory / "port").read_text())}/json'
            launch('external-http', url=url)
            proof['externalHttp'] = report('arxd-services-external-http')
            assert proof['externalHttp']['verified'] and proof['externalHttp']['endpoint'] == url
            assert proof['externalHttp']['policy']['allowPlaintextHttp'], 'Explicit trusted opt-in must be persisted for the next fresh stage'
            assert not proof['externalHttp']['processIds'] and (lan_directory / 'effects').read_text() == '3'
            assert (lan_directory / 'launches').read_text() == '1'
            proof['externalHttpClosed'] = report('arxd-services-owner-closed', 'external-http'); assert proof['externalHttpClosed']['verified']
            proof['externalHttpStages'] = []
            previous_pid = proof['externalHttp']['info']['processId']
            for stage in ['reopen', 'finish', 'resume']:
                adb('shell', 'am', 'force-stop', args.package)
                launch('external-http', stage=stage)
                result = report('arxd-services-external-http')
                assert result['verified'] and result['stage'] == stage and result['info']['processId'] != previous_pid
                previous_pid = result['info']['processId']
                assert (lan_directory / 'effects').read_text() == '3' and (lan_directory / 'initializations').read_text() == '3', 'Switch OFF/reopen must not connect or replay any request'
                assert report('arxd-services-owner-closed', 'external-http')['verified']
                proof['externalHttpStages'].append(result)
            assert proof['externalHttpStages'][-1]['complete']

            print(json.dumps({'stage': 'external-http', 'checks': len(proof['externalHttp']['checks']), 'endpoint': url}), flush=True)
            if args.external_http_only:
                proof['verified'] = True
                return
            adb('shell', 'am', 'force-stop', args.package)
        if not (args.background_only or args.native_mcp_only):
            launch('functional'); proof['functional'] = report('arxd-services-functional'); assert proof['functional']['verified']
            cleanup = report('arxd-services-cleanup', 'functional'); proof['functionalCleanup'] = cleanup
            assert not cleanup['cleanupFailures'], cleanup
            proof['functionalClosed'] = report('arxd-services-owner-closed', 'functional'); assert proof['functionalClosed']['verified']
            print(json.dumps({'stage': 'functional', 'checks': len(proof['functional']['checks'])}), flush=True)
            adb('shell', 'am', 'force-stop', args.package)
            launch('functional', stage='reopen'); proof['functionalReopen'] = report('arxd-services-functional-reopen'); assert proof['functionalReopen']['verified']
        if args.service_safety:
            adb('shell', 'am', 'force-stop', args.package)
            adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', 'arxd://verify-service-safety', '-n', args.package + '/.MainActivity')
            proof['serviceSafety'] = report('arxd-service-safety'); assert proof['serviceSafety']['verified']
            proof['serviceSafetyCleanup'] = report('arxd-service-safety-cleanup'); assert proof['serviceSafetyCleanup']['verified']
            proof['serviceBoundsCleanup'] = report('arxd-service-bounds-cleanup'); assert proof['serviceBoundsCleanup']['verified']
        if args.storage_faults:
            adb('shell', 'am', 'force-stop', args.package)
            launch('storage'); proof['storage'] = report('arxd-services-storage'); assert proof['storage']['verified']
            assert not proof['storage']['cleanupFailures'], proof['storage']
        if args.native_mcp or args.native_mcp_background:
            tls_directory = directory / 'untrusted-tls'
            tls_directory.mkdir()
            cert, key = tls_directory / 'cert.pem', tls_directory / 'key.pem'
            with (tls_directory / 'openssl.log').open('wb') as log:
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=arxd-independent-untrusted-fixture', '-keyout', str(key), '-out', str(cert)], check=True, stdout=log, stderr=log, timeout=30)
            key.chmod(0o600)
            tls_fixture = subprocess.Popen([sys.executable, str(ROOT / 'scripts/mcp-tls-fixture.py'), '--fixture', str(ROOT / 'native/services/mcp-fixture.py'), '--directory', str(tls_directory), '--cert', str(cert), '--key', str(key)], stdout=subprocess.DEVNULL, stderr=(tls_directory / 'server.log').open('wb'))
            deadline = time.monotonic() + 10
            while not (tls_directory / 'port').exists():
                if tls_fixture.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError('Independent TLS fixture did not start')
                time.sleep(.05)
            tls_port = int((tls_directory / 'port').read_text())
            assert f'tcp:{tls_port}' not in adb('reverse', '--list'), 'Do not replace an existing TLS fixture mapping'
            adb('reverse', f'tcp:{tls_port}', f'tcp:{tls_port}'); reversed_ports.append(tls_port)
            tls_url = 'https://127.0.0.1:' + str(tls_port) + '/mcp'
            adb('shell', 'am', 'force-stop', args.package)
            adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://verify-mcp?' + urlencode({'tlsUrl': tls_url, **({'background': '1'} if args.native_mcp_background else {})})), '-n', args.package + '/.MainActivity')
            if args.native_mcp_background:
                ready = report('arxd-mcp-native-ready-background')
                native_pid = host_pid()
                assert native_pid == str(ready['appPid']), 'Native readiness refers to a different App process'
                activity = activity_identity()
                native_background = {'pid': native_pid, 'activity': activity}
                host_port = int(adb('forward', 'tcp:0', 'tcp:' + str(ready['port'])).strip()); forwarded.append(host_port)
                samples = []
                observation = proof['nativeMcpBackground'] = {'verified': False, 'ready': ready, 'sameActivity': activity, 'samples': samples, 'lockObservations': []}
                def native_probe(phase):
                    before_lock = require_locked(f'native-sample-{len(samples)}-before') if phase != 'visible' else None
                    with urlopen(f'http://127.0.0.1:{host_port}/arxd-verification', timeout=5) as response:
                        raw = response.read(8193)
                    assert len(raw) <= 8192, 'Trusted native background marker response exceeds its budget'
                    item = json.loads(raw)
                    assert item['fixture'] == 'arxd-mcp-background-v1' and item['pid'] == ready['httpPayloadPid']
                    assert item['stdio']['pid'] == ready['stdioPayloadPid'] and item['httpLaunches'] == item['stdioLaunches'] == 1
                    assert host_pid() == native_pid, 'App process restarted during the locked native call'
                    matching = [entry for entry in item['stdio']['entries'] if entry['rpcId'] == ready['rpcId']]
                    assert len(matching) == 1, 'Missing or ambiguous correlated stdio slow request'
                    samples.append({'phase': phase, 'hostMonotonic': time.monotonic(), 'response': item, 'marker': matching[0], 'lockBefore': before_lock,
                                    'lockAfter': require_locked(f'native-sample-{len(samples)}-after') if phase != 'visible' else None})
                    return samples[-1]
                native_probe('visible')
                adb('shell', 'input', 'keyevent', '3')
                adb('shell', 'input', 'keyevent', '223'); locked = True
                # Screen-off and keyguard transitions are asynchronous. Observe both
                # within one finite window; never infer a lock from the key event.
                deadline = time.monotonic() + 5
                lock_observed = False
                while time.monotonic() < deadline:
                    attempt = {'hostMonotonic': time.monotonic()}
                    observation['lockObservations'].append(attempt)
                    try:
                        power = adb('shell', 'dumpsys', 'power', timeout=max(.01, deadline - time.monotonic()))
                        attempt['powerAsleep'] = bool(re.search(r'mWakefulness=(Asleep|Dozing)', power))
                        (directory / f'native-lock-{len(observation["lockObservations"])}-power.txt').write_text(power)
                        keyguard = adb('shell', 'dumpsys', 'window', 'policy', timeout=max(.01, deadline - time.monotonic()))
                        attempt['keyguardShowing'] = bool(re.search(r'\b(?:showing|isKeyguardShowing|mShowingLockscreen)\s*[=:]\s*true', keyguard))
                        (directory / f'native-lock-{len(observation["lockObservations"])}-keyguard.txt').write_text(keyguard)
                        lock_observed = attempt['powerAsleep'] and attempt['keyguardShowing']
                    except subprocess.TimeoutExpired as error:
                        attempt['error'] = str(error)
                    # Persist observations before assertions, including failed runs.
                    attempt['finishedHostMonotonic'] = time.monotonic()
                    (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
                    if lock_observed:
                        break
                    time.sleep(min(.2, max(0, deadline - time.monotonic())))
                assert lock_observed, 'Power asleep and keyguard showing were not both observed within 5 seconds'
                first_locked = native_probe('locked')
                assert first_locked['marker']['phase'] == 'started', 'Slow response completed before the observed lock interval'
                started = time.monotonic()
                while time.monotonic() - started < 16:
                    native_probe('locked')
                    time.sleep(min(1, max(.1, 16 - (time.monotonic() - started))))
                last_locked = native_probe('locked-final')
                marker = last_locked['marker']
                assert marker['phase'] == 'response-written' and marker['outcome'] == 'success'
                assert first_locked['response']['observedElapsedMs'] <= marker['finishedElapsedMs'] <= last_locked['response']['observedElapsedMs'], 'Correlated response was not flushed during the independently observed locked interval'
                observation['finalLock'] = require_locked('native-lock-final')
                # Resume the captured Activity, including an observed charging
                # screensaver overlay, without restarting the route or host.
                resume_native_activity('success'); locked = False
                finished = report('arxd-mcp-native-background-finished')
                assert finished['verified'] and finished['appPid'] == ready['appPid'] and finished['rpcId'] == ready['rpcId']
                assert finished['processId'] == ready['processId'] and finished['httpProcessId'] == ready['httpProcessId']
                assert finished['stdioPayloadPid'] == ready['stdioPayloadPid'] and finished['httpPayloadPid'] == ready['httpPayloadPid']
                assert finished['actualJsHoldMs'] >= ready['jsHoldMs']
                assert finished['jsHoldStartedEpochMs'] <= marker['finishedEpochMs'] <= finished['jsHoldFinishedEpochMs'], 'Server response did not complete during the bounded unavailable-JS interval'
                observation.update({'verified': True, 'ready': ready, 'finished': finished, 'sameActivity': activity,
                    'durationSeconds': time.monotonic() - started, 'samples': samples,
                    'powerLocked': '\n'.join(line for line in power.splitlines() if any(key in line for key in ['mWakefulness=', 'mIsPowered=', 'mBatteryLevel=', 'Arxd:managed-processes'])),
                    'keyguardLocked': '\n'.join(line for line in keyguard.splitlines() if 'keyguard' in line.lower() or 'showing=' in line)[:4096]})
            proof['nativeMcp'] = report('arxd-mcp-native'); assert proof['nativeMcp']['verified'] and proof['nativeMcp']['tlsTrustTested']
            proof['nativeMcpCleanup'] = report('arxd-mcp-native-cleanup'); assert proof['nativeMcpCleanup']['verified']
            native_background = None
            posts = int((tls_directory / 'http_posts').read_text()) if (tls_directory / 'http_posts').exists() else 0
            assert posts == 0, 'TLS trust failure sent an application-layer POST to the untrusted server'
            proof['untrustedTls'] = {'applicationPosts': posts, 'fixtureLaunches': (tls_directory / 'launches').read_text(), 'trustOverrides': False}
            adb('reverse', '--remove', f'tcp:{tls_port}'); reversed_ports.remove(tls_port)
            tls_fixture.terminate(); tls_fixture.wait(timeout=3); tls_fixture = None
        if args.checkpoints:
            external_directory = directory / 'external-mcp'
            external = subprocess.Popen([sys.executable, str(ROOT / 'native/services/mcp-fixture.py'), 'http', str(external_directory)], stdout=subprocess.PIPE, stderr=(directory / 'external-mcp.log').open('wb'))
            deadline = time.monotonic() + 10
            while not (external_directory / 'port').exists():
                if external.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError('Independent external MCP fixture did not start')
                time.sleep(.05)
            external_port = int((external_directory / 'port').read_text())
            assert f'tcp:{external_port}' not in adb('reverse', '--list'), 'Do not replace an existing device reverse mapping'
            adb('reverse', f'tcp:{external_port}', f'tcp:{external_port}')
            reversed_ports.append(external_port)
            for profile in ['intent', 'spawn', 'result', 'input', 'mcp']:
                adb('shell', 'am', 'force-stop', args.package)
                launch(profile, url=f'http://127.0.0.1:{external_port}/json' if profile == 'mcp' else '')
                checkpoint = report('arxd-services-checkpoint', profile)
                before = host_pid()
                if profile == 'mcp':
                    assert (external_directory / 'effects').read_text() == '1'
                adb('shell', 'am', 'force-stop', args.package)
                launch(profile, 'resume')
                after = host_pid()
                assert before != after, 'Recovery reused the old Android process'
                recovered = report('arxd-services-recovered', profile); assert recovered['verified']
                if profile == 'mcp':
                    assert (external_directory / 'effects').read_text() == '1', 'Pending unsafe MCP mutation replayed'
                    assert (external_directory / 'launches').read_text() == '1'
                cleanup = report('arxd-services-cleanup', profile)
                assert not cleanup['cleanupFailures'], cleanup
                proof['checkpoints'].append({'profile': profile, 'checkpoint': checkpoint, 'recovered': recovered, 'cleanup': cleanup})
                print(json.dumps({'stage': 'no-replay', 'profile': profile}), flush=True)
            adb('reverse', '--remove', f'tcp:{external_port}'); reversed_ports.remove(external_port)
        if args.background_seconds and not args.native_mcp_only:
            adb('shell', 'am', 'force-stop', args.package)
            launch('background')
            ready = report('arxd-services-background-ready'); assert ready['verified']
            host_port = int(adb('forward', 'tcp:0', 'tcp:' + str(ready['port'])).strip())
            forwarded.append(host_port)
            samples = []
            background = proof['background'] = {'verified': False, 'ready': ready, 'samples': samples, 'lockObservations': []}
            native_pid = host_pid()
            assert native_pid == str(ready['pid']), 'HTTP readiness refers to a different App process'
            def probe(phase):
                before_lock = require_locked(f'http-sample-{len(samples)}-before') if phase.startswith('locked') else None
                with urlopen(f'http://127.0.0.1:{host_port}/health', timeout=5) as response:
                    raw = response.read(8193)
                assert len(raw) <= 8192, 'Trusted HTTP response exceeds its fixture budget'
                item = json.loads(raw)
                assert item['fixture'] == 'arxd-managed-http-v1'
                assert host_pid() == native_pid, 'App host restarted during the HTTP interval'
                sample = {'phase': phase, 'hostMonotonic': time.monotonic(), 'response': item, 'lockBefore': before_lock,
                          'lockAfter': require_locked(f'http-sample-{len(samples)}-after') if phase.startswith('locked') else None}
                samples.append(sample)
                return sample
            visible = probe('visible')
            proof['serviceBeforeBackground'] = adb('shell', 'dumpsys', 'activity', 'services', args.package)
            adb('shell', 'input', 'keyevent', '3')
            probe('background')
            adb('shell', 'input', 'keyevent', '223'); locked = True
            deadline = time.monotonic() + 5
            lock_observed = False
            while time.monotonic() < deadline:
                sample = observed_lock(f'http-lock-{len(background["lockObservations"])}', timeout=max(.01, deadline - time.monotonic()))
                background['lockObservations'].append(sample)
                lock_observed = sample['powerAsleep'] and sample['keyguardShowing']
                if lock_observed:
                    break
                time.sleep(min(.2, max(0, deadline - time.monotonic())))
            assert lock_observed, 'Actual HTTP interval never reached both power asleep and keyguard showing within 5 seconds'
            started = time.monotonic()
            first_locked = probe('locked-first')
            while time.monotonic() - started < args.background_seconds:
                probe('locked')
                time.sleep(min(2, max(.1, args.background_seconds - (time.monotonic() - started))))
            final_locked = probe('locked-final')
            background.update(durationSeconds=time.monotonic() - started,
                              samePid=len({item['response']['pid'] for item in samples}) == 1,
                              finalLock=require_locked('http-lock-final'))
            assert background['samePid'], 'HTTP listener payload identity changed during its observed lifetime'
            assert final_locked['response']['requests'] > first_locked['response']['requests'] > visible['response']['requests'], 'Independent fsynced requests did not continue during actual locked samples'
            wait_for_physical_unlock('http-finish'); locked = False
            assert host_pid() == native_pid, 'App host restarted before HTTP finish'
            launch('background', 'finish')
            proof['background']['finished'] = report('arxd-services-background-finished'); assert proof['background']['finished']['verified']
            assert not proof['background']['finished']['cleanupFailures'], proof['background']['finished']
            background['verified'] = True
            print(json.dumps({'stage': 'background', 'durationSeconds': proof['background']['durationSeconds'], 'requests': len(samples)}), flush=True)
        proof['verified'] = True
    finally:
        if locked and not native_background:
            try:
                wait_for_physical_unlock('failed-http-proof-cleanup')
            except Exception as error:
                proof['wakeCleanupError'] = str(error)
        if native_background:
            try:
                # Resume only the captured, still-existing Activity and host. A
                # failed proof must not start another route or orphan the old one.
                resume_native_activity('failed-proof-cleanup')
                cleanup = report('arxd-mcp-native-cleanup', timeout=60)
                proof['nativeMcpBackgroundRecovery'] = cleanup
                assert cleanup['verified'], cleanup
            except Exception as error:
                proof['nativeMcpBackgroundRecoveryError'] = str(error)
        for port in reversed_ports:
            adb('reverse', '--remove', f'tcp:{port}')
        for port in forwarded:
            adb('forward', '--remove', f'tcp:{port}')
        if tls_fixture:
            tls_fixture.terminate()
            try:
                tls_fixture.wait(timeout=3)
            except subprocess.TimeoutExpired:
                tls_fixture.kill(); tls_fixture.wait(timeout=3)
        if lan_fixture:
            lan_fixture.terminate()
            try:
                lan_fixture.wait(timeout=3)
            except subprocess.TimeoutExpired:
                lan_fixture.kill(); lan_fixture.wait(timeout=3)
        if external:
            external.terminate()
            try:
                external.wait(timeout=3)
            except subprocess.TimeoutExpired:
                external.kill(); external.wait(timeout=3)
        try:
            (directory / 'final.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        except Exception as error:
            proof['captureError'] = str(error)
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'verified': proof['verified'], 'scope': scope, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
