#!/usr/bin/env python3
"""Install only Arxd and verify its in-App official-source LD_PRELOAD experiment."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default=PACKAGE)
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--offline-toolchain', action='store_true')
    parser.add_argument('--bundle-failures', action='store_true')
    parser.add_argument('--bootstrap-only', action='store_true')
    parser.add_argument('--no-install', action='store_true')
    parser.add_argument('--ui', action='store_true', help='Use the screen entry point; requires manual unlock')
    parser.add_argument('--reset-runtime', action='store_true', help='Delete only the generated experimental runtime before a fresh installation test')
    parser.add_argument('--timeout', type=int, default=1200)
    args = parser.parse_args()
    package = args.package
    if args.bootstrap_only and (args.offline_toolchain or args.bundle_failures):
        parser.error('--bootstrap-only cannot be combined with offline-toolchain/failure acceptance')
    if args.ui and (args.offline_toolchain or args.bundle_failures):
        parser.error('Offline toolchain/failure acceptance uses the Android native verifier')
    if args.ui and args.reset_runtime:
        parser.error('--reset-runtime is supported by the native verifier only')
    adb_bin = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))

    def adb(*command, check=True):
        result = subprocess.run([adb_bin, '-s', args.serial, *command], capture_output=True, text=True, timeout=120)
        if check and result.returncode:
            raise RuntimeError(result.stderr + result.stdout)
        return result.stdout

    directory = ROOT / 'target/arxd/preload/evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = args.apk or ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    manifest = json.loads((ROOT / 'target/arxd/preload/assets/termux-bootstrap.json').read_text())
    assert hashlib.sha256((ROOT / 'apps/arxd/native/preload/compat.c').read_bytes()).hexdigest() == manifest['sourceSha256']
    for path, expected in manifest['sourceFiles'].items():
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, path
    probes_sha256 = hashlib.sha256((ROOT / 'apps/arxd/native/preload/probes.json').read_bytes()).hexdigest()
    with zipfile.ZipFile(apk) as archive:
        assert hashlib.sha256(archive.read('lib/arm64-v8a/libarxdpreload.so')).hexdigest() == manifest['shimSha256']
        assert hashlib.sha256(archive.read('assets/termux-bootstrap.zip')).hexdigest() == manifest['sha256']
        assert hashlib.sha256(archive.read('assets/termux-probes.json')).hexdigest() == probes_sha256
        if args.offline_toolchain:
            runtime_manifest = json.loads(archive.read('assets/termux-runtime-packages.json'))
            assert hashlib.sha256(archive.read('assets/termux-runtime-packages.zip')).hexdigest() == runtime_manifest['bundleSha256']
            assert archive.read('assets/termux-toolchain-probe.sh') == (ROOT / 'apps/arxd/native/preload/toolchain-probe.sh').read_bytes()
    if not args.no_install:
        print(adb('install', '-r', str(apk)), flush=True)
    adb('shell', 'am', 'force-stop', package)
    action = 'preload-bootstrap' if args.bootstrap_only else 'preload'
    if args.ui:
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', f'arxd://verify?action={action}', '-n', f'{package}/.MainActivity')
    else:
        adb('shell', 'am', 'start-foreground-service', '-n', f'{package}/expo.modules.arxdrxd.PreloadVerificationService',
            '--ez', 'bootstrapOnly', str(args.bootstrap_only).lower(), '--ez', 'resetRuntime', str(args.reset_runtime).lower(),
            '--ez', 'offlineToolchain', str(args.offline_toolchain).lower(), '--ez', 'bundleFailures', str(args.bundle_failures).lower())
    fragments, delivered = {}, set()
    evidence = {'verifiedAtUtc': datetime.now(timezone.utc).isoformat(), 'manifest': manifest,
                'resetRuntime': args.reset_runtime,
                'probesSha256': probes_sha256,
                'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'reports': []}
    deadline = time.monotonic() + args.timeout
    pid = ''
    completed = None
    last_pid = ''
    started_waiting = time.monotonic()
    while time.monotonic() < deadline:
        pid = adb('shell', 'pidof', package, check=False).strip()
        if pid:
            last_pid = pid
        elif last_pid:
            pid = last_pid
        elif time.monotonic() - started_waiting > 30:
            break
        if pid:
            for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines():
                try:
                    packet = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if packet.get('event') not in ('arxd-verification-preload', 'arxd-preload'):
                    continue
                key = (packet['runId'], packet['messageId'])
                group = fragments.setdefault(key, {})
                group[packet['index']] = packet['data']
                if len(group) == packet['parts'] and key not in delivered:
                    delivered.add(key)
                    report = json.loads(''.join(group[index] for index in range(packet['parts'])))
                    evidence['reports'].append(report)
                    (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
                    print(json.dumps({'kind': report['kind'], 'stage': report.get('stage'), 'result': report.get('result'), 'error': report.get('error')}, ensure_ascii=False), flush=True)
                    if report['kind'] == 'complete':
                        completed = report
        if completed:
            break
        time.sleep(2)
    evidence['pid'] = pid
    evidence['model'] = adb('shell', 'getprop', 'ro.product.model').strip()
    evidence['androidApi'] = adb('shell', 'getprop', 'ro.build.version.sdk').strip()
    evidence['abi'] = adb('shell', 'getprop', 'ro.product.cpu.abi').strip()
    evidence['pageSize'] = adb('shell', 'getconf', 'PAGESIZE').strip()
    evidence['selinux'] = adb('shell', 'getenforce').strip()
    evidence['appProcess'] = adb('shell', 'ps', '-p', pid, '-o', 'UID,LABEL,NAME').strip() if pid else ''
    evidence['existingTermuxPackage'] = adb('shell', 'pm', 'list', 'packages', 'com.termux').strip()
    evidence['complete'] = completed
    evidence['verified'] = False
    (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    assert completed, f'No completion report; evidence: {directory}'
    assert not completed.get('error'), f'{completed.get("error")}; evidence: {directory}'
    identity = completed['identity']
    assert identity['shimSha256'] == manifest['shimSha256'] and identity['bootstrapSha256'] == manifest['sha256']
    assert identity['packageName'] == package and identity['uid'] >= 10000 and identity['pid'] == int(pid)
    assert identity['targetSdk'] >= 29 and identity['debuggable'] is False
    assert identity['root'].startswith(f'/data/user/0/{package}/')
    assert evidence['selinux'] == 'Enforcing' and 'untrusted_app' in evidence['appProcess']
    expected = ['offline-toolchain'] if args.offline_toolchain else ['bootstrap'] if args.bootstrap_only else ['bootstrap', 'update', 'install', 'python', 'node', 'exec', 'packages', 'cancel']
    if args.bundle_failures:
        expected.append('runtime-failures')
    assert [stage['stage'] for stage in completed['stages']] == expected
    assert all(stage['result']['exitCode'] == 0 for stage in completed['stages'])
    assert all(stage['result']['identity'] == identity for stage in completed['stages'] if stage['stage'] != 'runtime-failures')
    if not args.bootstrap_only and not args.offline_toolchain:
        update = next(stage['result'] for stage in completed['stages'] if stage['stage'] == 'update')
        assert '[GNUPG:] VALIDSIG ' in update['stdout'] and 'apt-key succeeded' in update['stderr']
        for name in ('python', 'node'):
            output = next(stage['result']['stdout'] for stage in completed['stages'] if stage['stage'] == name)
            probe = json.loads(output.strip().splitlines()[-1])
            assert probe['probe'] == name and probe['uid'] == identity['uid'] and probe['child'] == '42'
            assert probe['cleanChild'] == '64' and probe['shellChild'].strip() == '42'
            assert probe['sha256'] == hashlib.sha256(b'arxd').hexdigest()
            if name == 'python':
                assert probe['packaging']['exitCode'] == 0
            else:
                assert probe['pythonChild'] == '56'
        exec_probe = json.loads(next(stage['result']['stdout'] for stage in completed['stages'] if stage['stage'] == 'exec').strip().splitlines()[-1])
        assert exec_probe['mkdirParents'] is True
        assert completed['verified'] is True
    if args.offline_toolchain:
        runtime_pin = json.loads((ROOT / 'target/arxd/preload/assets/termux-runtime-packages.json').read_text())
        assert identity['runtimeBundleSha256'] == runtime_pin['bundleSha256']
        probe = json.loads(completed['stages'][0]['result']['stdout'].strip().splitlines()[-1])
        assert probe['probe'] == 'offline-toolchain' and probe['uid'] == identity['uid']
        assert all(probe[key] is True for key in ('venv', 'localWheel', 'uvx', 'localNpm', 'npx', 'emptyEnvironmentChildren', 'shellChildren', 'nodePythonChild'))
    if args.bundle_failures:
        failures = json.loads(completed['stages'][-1]['result']['stdout'])
        assert failures['rejected'] == ['missing-bundle', 'corrupt-bundle', 'incompatible-bootstrap']
        assert all(failures[key] is True for key in ('retryReady', 'abandonedStageRemoved', 'executableModeChecked', 'homeAndWorkspacePreserved'))
    evidence['verified'] = not args.bootstrap_only
    evidence['bootstrapVerified'] = True
    (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'verified': evidence['verified'], 'bootstrapVerified': True, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
