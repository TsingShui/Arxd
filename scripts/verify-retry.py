#!/usr/bin/env python3
"""Exercise #159 through the installed Android App; never installs or resets it.
Start retry-fault-server.py first; --package must identify the coordinated test APK.
Screenshots, logcat and independent endpoint requests are saved under target/.
"""
from android_reports import read_reports
import argparse
import hashlib
import re
import xml.etree.ElementTree as ET
import json
from pathlib import Path
import shlex
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

DEFAULT = ['configuredNativeDeadline', 'configuredDeadline', 'configuredDeadlineStop', 'network1', 'network2', 'network3', 'exhausted', 'http400', 'http401', 'http403', 'http404', 'http429', 'http500', 'http503', 'http503zero', 'networkThen401', 'partial', 'partialExhausted', 'fragments', 'nativeProtocol', 'emptyError', 'malformed', 'incomplete', 'overflow', 'unknown', 'refused', 'dns', 'toolNoReplay', 'serviceNoReplay', 'toolFailure', 'diagnostic', 'configGuard', 'certificate', 'tlsClose', 'invalidEndpoint', 'responseStopRace', 'invalidModel', 'invalidParameters', 'quota', 'subsequentRequest', 'responsesExhausted', 'anthropicExhausted', 'googleExhausted', 'activeStop', 'compactionNetwork', 'compactionHttp', 'compactionConcurrent', 'compactionBlocking', 'compactionBackground']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--apk', type=Path, required=True, help='Immutable APK whose SHA256 must match the installed test package')
    parser.add_argument('--package', required=True)
    parser.add_argument('--cases', nargs='+', default=DEFAULT)
    parser.add_argument('--background-configured', action='store_true', help='Home the app during the first configuredNativeDeadline request; verify native disconnect before foregrounding')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--full', action='store_true', help='Include real 90s deadline and fresh-process interruption/cancel checks')
    mode.add_argument('--recovery-lifecycle-only', action='store_true', help='Only run existing short backoff cancel/reopen and interrupted-process recovery checks; skip case list and long deadlines')
    args = parser.parse_args()
    if not args.package.startswith('art.tsingshui.arxd.'):
        parser.error('Use an isolated Arxd acceptance package, not the user App')
    root = Path(__file__).resolve().parents[3]
    directory = root / 'target/arxd/retry-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    scope = 'recovery-lifecycle-only' if args.recovery_lifecycle_only else 'full' if args.full else 'selected-cases'
    cases = [] if args.recovery_lifecycle_only else args.cases + (['deadline', 'streamingDeadline', 'deadlineExhausted'] if args.full else [])
    results = []
    recovery_ui = {'requiredCases': [], 'observed': [], 'notCaptured': []}

    def adb(*command, binary=False):
        value = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if value.returncode:
            raise RuntimeError(str(value.stderr))
        return value.stdout

    installed = adb('shell', 'pm', 'path', args.package).strip().splitlines()
    if len(installed) != 1 or not installed[0].startswith('package:'):
        raise AssertionError('Expected exactly one installed base APK')
    local_sha = hashlib.sha256(args.apk.read_bytes()).hexdigest()
    remote_sha = adb('shell', 'sha256sum', installed[0][8:]).split()[0]
    if remote_sha != local_sha:
        raise AssertionError('Local --apk does not identify installed Android bytes')
    identity = {'serial': args.serial, 'package': args.package, 'apk': str(args.apk.resolve()), 'apkSha256': local_sha,
                'android': adb('shell', 'getprop', 'ro.build.version.release').strip(), 'sdk': adb('shell', 'getprop', 'ro.build.version.sdk').strip(),
                'abi': adb('shell', 'getprop', 'ro.product.cpu.abi').strip()}
    (directory / 'installed-build.json').write_text(json.dumps(identity, indent=2))

    def hierarchy(label):
        adb('shell', 'uiautomator', 'dump', '/sdcard/arxd-retry-ui.xml')
        raw = adb('shell', 'cat', '/sdcard/arxd-retry-ui.xml')
        (directory / (label + '.xml')).write_text(raw)
        return ET.fromstring(raw)

    def inspect_terminal_ui(case_id, result, phase):
        if not result.get('failures'):
            return
        tree = hierarchy(case_id + '-' + phase + '-ui')
        nodes = list(tree.iter('node'))
        if not any(node.get('resource-id', '').endswith('request-error') for node in nodes):
            raise AssertionError('Actual conversation UI hid durable request-error records')
        visible = ' '.join(node.get('text', '') for node in nodes)
        if result['failures'][-1]['category'] not in visible:
            raise AssertionError('Actual UI hid the final failure category')
        if result.get('case') in ('partial', 'partialExhausted', 'streamingDeadline'):
            if 'INTERRUPTED_FIXTURE_PREFIX' not in visible:
                raise AssertionError('Actual UI hid retained failed text')
            for label in ['展开执行过程', 'Expand execution', '展开思考内容', 'Expand thinking']:
                tree = hierarchy(case_id + '-' + phase + '-expand-' + re.sub('[^a-zA-Z]', '', label))
                match = next((node for node in tree.iter('node') if label in node.get('content-desc', '')), None)
                if match is not None:
                    coordinates = [int(value) for value in re.findall(r'\d+', match.get('bounds', ''))]
                    if len(coordinates) == 4:
                        adb('shell', 'input', 'tap', str((coordinates[0] + coordinates[2]) // 2), str((coordinates[1] + coordinates[3]) // 2))
            tree = hierarchy(case_id + '-' + phase + '-thinking-open')
            if result.get('case') in ('partial', 'partialExhausted') and 'INTERRUPTED_FIXTURE_THINKING' not in ' '.join(node.get('text', '') for node in tree.iter('node')):
                raise AssertionError('Actual UI could not reveal retained failed thinking')

    def evidence():
        with urllib.request.urlopen('http://127.0.0.1:18759/evidence', timeout=5) as response:
            return json.load(response)

    def received_attempts(case_id):
        case = evidence()[case_id]
        return len(case['requests']) + case.get('tlsConnectionCount', 0)

    def launch(name, run, **options):
        adb('shell', 'am', 'force-stop', args.package)
        query = urllib.parse.urlencode({'case': name, 'run': run, **options})
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://verify-retry?' + query), '-n', args.package + '/.MainActivity')

    def reports():
        pids = adb('shell', 'pidof', args.package).split()
        # Fork/exec can briefly expose a same-name child. Defer this observation
        # within the caller's existing deadline; never guess a host by PID order.
        if len(pids) != 1 or not re.fullmatch(r'[0-9]+', pids[0]) or int(pids[0]) <= 1:
            return []
        return read_reports(adb('logcat', '-d', '--pid=' + pids[0], '-v', 'raw', '-s', 'ArxdVerify:I', '*:S'))

    def retry_state(records):
        # logcat is history, not a live-state feed. A terminal report wins over
        # all earlier recovery reports, and only the newest progress is current.
        terminal = next((record for record in reversed(records) if record.get('event') == 'arxd-retry-result'), None)
        progress = next((record for record in reversed(records) if record.get('event') == 'arxd-retry-progress'), None)
        pending = progress if progress and progress.get('phase') == 'recovery' and progress.get('status') == 'running' and progress.get('recovery') else None
        return terminal, pending

    def pending_key(record):
        recovery = (record or {}).get('recovery', {})
        return recovery.get('attempt'), recovery.get('at'), recovery.get('error')

    def record_recovery_ui(observation, observed=False):
        recovery_ui['observed' if observed else 'notCaptured'].append(observation)
        (directory / 'pending-recovery-ui.json').write_text(json.dumps(recovery_ui, ensure_ascii=False, indent=2))

    def wait_result(case_id, timeout=120, phase='initial'):
        until = time.monotonic() + timeout
        captured = set()

        def finish(record, records):
            (directory / (case_id + '-' + phase + '.json')).write_text(json.dumps({'reports': records, 'server': evidence().get(case_id), 'pendingRecoveryUi': recovery_ui}, ensure_ascii=False, indent=2))
            (directory / (case_id + '-' + phase + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
            if not record.get('verified'):
                raise AssertionError(record)
            return record

        while time.monotonic() < until:
            records = [record for record in reports() if record.get('id') == case_id]
            had_recovery = any((record.get('event') == 'arxd-retry-progress' and record.get('phase') == 'recovery' and record.get('recovery')) or (record.get('event') == 'arxd-retry-result' and any(failure.get('retryable') for failure in record.get('failures') or [])) for record in records)
            if had_recovery and case_id not in recovery_ui['requiredCases']:
                recovery_ui['requiredCases'].append(case_id)
            terminal, pending = retry_state(records)
            if terminal:
                if had_recovery and not any(item['caseId'] == case_id and item['phase'] == phase for item in recovery_ui['observed'] + recovery_ui['notCaptured']):
                    record_recovery_ui({'caseId': case_id, 'phase': phase, 'reason': 'terminal-before-pending-capture', 'terminal': terminal.get('status')})
                return finish(terminal, records)
            # The third backoff is the longest (4s). Do not spend its window
            # taking screenshots for already-ended first/second backoffs.
            if pending and pending_key(pending)[0] == 3 and pending_key(pending) not in captured:
                key = pending_key(pending)
                before = [record for record in reports() if record.get('id') == case_id]
                terminal, current = retry_state(before)
                if terminal:
                    record_recovery_ui({'caseId': case_id, 'phase': phase, 'reason': 'terminal-before-pending-capture', 'candidate': key})
                    return finish(terminal, before)
                if pending_key(current) != key:
                    continue
                captured.add(key)
                label = case_id + '-' + phase + '-recovery-3'
                tree = hierarchy(label + '-ui')
                (directory / (label + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
                marker = next((node for node in tree.iter('node') if node.get('resource-id', '').endswith('request-network-recovery')), None)
                text = ' '.join(node.get('text', '') for node in marker.iter('node')) if marker is not None else ''
                countdown = re.search(r'(?:[0-4]\s*秒后尝试|next attempt in [0-4]s)', text)
                cause = current['recovery'].get('error', '')
                error = 'Actual conversation UI hid the pending retry ordinal/countdown' if marker is None or '3/3' not in text or not countdown else 'Actual recovery UI hid its concrete failure cause' if not cause or cause[:40] not in text else None
                after = [record for record in reports() if record.get('id') == case_id]
                ended, following = retry_state(after)
                # A hierarchy capture may straddle the deadline or settlement.
                # Allow report delivery to catch up, never infer a pending UI
                # pass from a terminal screen or silently ignore a live failure.
                settle_until = time.monotonic() + .5
                while error and not ended and pending_key(following) == key and time.monotonic() < settle_until:
                    time.sleep(.05)
                    after = [record for record in reports() if record.get('id') == case_id]
                    ended, following = retry_state(after)
                observation = {'caseId': case_id, 'phase': phase, 'ordinal': 3, 'candidate': key, 'xml': label + '-ui.xml', 'screenshot': label + '.png', 'before': current, 'after': following, 'terminalAfterCapture': bool(ended)}
                if not error:
                    record_recovery_ui({**observation, 'reason': 'observed-pending-banner-ordinal-and-cause'}, observed=True)
                elif ended or pending_key(following) != key:
                    record_recovery_ui({**observation, 'reason': 'terminal-during-capture' if ended else 'pending-state-advanced-during-capture', 'unobservedCheck': error})
                else:
                    record_recovery_ui({**observation, 'reason': 'current-pending-ui-failed', 'error': error})
                    raise AssertionError(error)
                if ended:
                    return finish(ended, after)
            time.sleep(.15)
        raise AssertionError('No Android result for ' + case_id)

    adb('reverse', 'tcp:18759', 'tcp:18759')
    adb('reverse', 'tcp:18760', 'tcp:18760')
    adb('reverse', 'tcp:18762', 'tcp:18762')
    try:
        for name in cases:
            run = uuid.uuid4().hex[:12]
            case_id = run + '-' + name
            launch(name, run)
            if args.background_configured and name == 'configuredNativeDeadline':
                until = time.monotonic() + 30
                while time.monotonic() < until:
                    received = evidence().get(case_id, {}).get('requests', [])
                    if received:
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('Configured request was not received')
                until = time.monotonic() + 2
                while time.monotonic() < until:
                    if any(record.get('event') == 'arxd-retry-js-block' and record.get('id') == case_id for record in reports()):
                        break
                    time.sleep(.02)
                else:
                    raise AssertionError('No active JavaScript-block checkpoint')
                assert not evidence()[case_id]['requests'][0].get('disconnectedAt'), 'Request ended before background checkpoint'
                adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                until = time.monotonic() + 5
                while time.monotonic() < until:
                    received = evidence()[case_id]['requests']
                    if received[0].get('disconnectedAt'):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('Native configured deadline did not disconnect in background')
                (directory / (case_id + '-background-server.json')).write_text(json.dumps(evidence()[case_id], indent=2))
                assert received[0]['disconnectedAt'] - received[0]['at'] <= 2.5
                time.sleep(3)
                adb('shell', 'am', 'start', '-W', '-n', args.package + '/.MainActivity')
            result = wait_result(case_id, 410 if name in ('deadline', 'streamingDeadline', 'deadlineExhausted') else 120)
            inspect_terminal_ui(case_id, result, 'initial')
            # A fresh process must show the same stored outcome, without a send.
            before = received_attempts(case_id)
            launch(name, run, resume='1')
            reopened = wait_result(case_id, phase='reopened')
            inspect_terminal_ui(case_id, reopened, 'reopened')
            time.sleep(4.5)
            after = received_attempts(case_id)
            assert before == after, 'Opening history dispatched another model request'
            assert reopened['status'] == result['status'] and reopened.get('failures') == result.get('failures'), 'Reopening changed persisted outcome'
            results.append(result)
            print(json.dumps({'case': name, 'verified': True, 'requests': result['requests'], 'nativeConnections': result.get('nativeConnections')}), flush=True)
        if args.full or args.recovery_lifecycle_only:
            for stop in [1, 2, 3]:
                run = uuid.uuid4().hex[:12]
                case_id = run + '-exhausted'
                launch('exhausted', run, stop=str(stop))
                result = wait_result(case_id)
                assert result['requests'] == stop, 'Cancel scheduled an extra dispatch'
                time.sleep(4.5)
                assert len(evidence()[case_id]['requests']) == stop
                launch('exhausted', run, resume='1', stop=str(stop))
                reopened = wait_result(case_id, phase='reopened-stopped-' + str(stop))
                time.sleep(4.5)
                assert len(evidence()[case_id]['requests']) == stop and reopened['status'] == 'stopped' and reopened.get('failures') == result.get('failures'), 'Reopening canceled recovery restarted work or changed durable causes'
                results.append(result)
            # Kill an observed backoff, preserving its consumed attempts/schedule.
            run = uuid.uuid4().hex[:12]
            case_id = run + '-network3'
            launch('network3', run)
            until = time.monotonic() + 30
            while time.monotonic() < until:
                if any(record.get('id') == case_id and record.get('recovery', {}).get('attempt') == 2 for record in reports()):
                    break
                time.sleep(.1)
            else:
                raise AssertionError('No live backoff to interrupt')
            launch('network3', run, resume='1')
            recovered_wait = wait_result(case_id, phase='recovered-backoff')
            assert recovered_wait['requests'] == 4 and len(recovered_wait['failures']) == 3, 'Backoff recovery reset request budget'
            results.append(recovered_wait)
            # Kill a genuinely live dispatched request, then recover in a new process.
            run = uuid.uuid4().hex[:12]
            case_id = run + '-interrupted'
            launch('interrupted', run)
            until = time.monotonic() + 30
            while time.monotonic() < until:
                if len(evidence().get(case_id, {}).get('requests', [])) == 1:
                    break
                time.sleep(.1)
            else:
                raise AssertionError('No live dispatch to interrupt')
            launch('interrupted', run, resume='1')
            recovered = wait_result(case_id, phase='recovered-live')
            assert recovered['requests'] == 2
            assert recovered['failures'][0]['attempt'] == 1 and 'unknown' in recovered['failures'][0]['message']
            results.append(recovered)
        if recovery_ui['requiredCases'] and not recovery_ui['observed']:
            (directory / 'summary.json').write_text(json.dumps({'verified': False, 'scope': scope, 'cases': cases, 'pendingRecoveryUi': recovery_ui, 'results': results}, ensure_ascii=False, indent=2))
            raise AssertionError('Pending recovery UI acceptance is unproven: capture at least one live third-backoff banner with ordinal/countdown and concrete cause; terminal or advanced captures do not count')
        (directory / 'summary.json').write_text(json.dumps({'verified': True, 'scope': scope, 'cases': cases, 'pendingRecoveryUi': recovery_ui, 'device': args.serial, 'package': args.package, 'installedBuild': identity, 'results': results}, ensure_ascii=False, indent=2))
        print(json.dumps({'verified': True, 'scope': scope, 'evidence': str(directory)}))
    except Exception:
        (directory / 'failure-logcat.txt').write_text(adb('logcat', '-d', '-v', 'threadtime', '-t', '2000'))
        raise


if __name__ == '__main__':
    main()
