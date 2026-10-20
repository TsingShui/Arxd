#!/usr/bin/env python3
"""Verify the real Arxd APK on an explicitly selected Android device. No emulator."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'art.tsingshui.arxd'
SAMPLE_SHA256 = 'd0e6da49d8dbff1ccfd185d4536cc6e3437eb83270570d6ca0b45699001d9c21'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--apk', type=Path, default=ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk')
    parser.add_argument('--reset-app', dest='reset_app', action='store_true', help='Clear only this dedicated verification package before the run')
    parser.add_argument('--screenshot', action='store_true', help='Capture the App after the owner manually unlocks the phone')
    args = parser.parse_args()

    def adb(*command):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise RuntimeError(result.stderr + result.stdout)
        return result.stdout

    assert args.apk.is_file(), f'APK missing: {args.apk}'
    manifest = json.loads((ROOT / 'target/arxd/native-metadata/rxd-build.json').read_text())
    adb('install', '-r', str(args.apk))
    if args.reset_app:
        assert 'Success' in adb('shell', 'pm', 'clear', PACKAGE)

    evidence = {'verifiedAtUtc': datetime.now(timezone.utc).isoformat(), 'manifest': manifest, 'stages': []}

    def stage(action):
        adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
            '-d', f'arxd://verify?action={action}', '-n', f'{PACKAGE}/.MainActivity')
        deadline = time.monotonic() + 45
        pid = ''
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE).strip()
            if pid:
                for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines():
                    try:
                        report = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if report.get('event') != 'arxd-verification':
                        continue
                    if report.get('stage') == 'error':
                        raise AssertionError(report)
                    if report.get('stage') == action:
                        if 'engine' in report:
                            assert report['engine']['processId'] == int(pid), report
                        evidence['stages'].append({'pid': int(pid), **report})
                        return report
            time.sleep(0.5)
        diagnostics = adb('logcat', '-d', '--pid=' + pid, '-t', '100') if pid else 'App process is not running'
        raise AssertionError(f'No {action} report: {diagnostics}')

    seed = stage('seed')
    assert (seed['userCount'], seed['answerCount'], seed['toolCount'], seed['toolErrors']) == (1, 1, 1, 0), seed
    assert seed['engine']['debuggable'] is False, seed
    assert seed['engine']['engineSha256'] == manifest['binarySha256'], seed
    stage('checkpoint')
    recovered = stage('recover')
    assert recovered['conversationId'] == seed['conversationId']
    assert (recovered['userCount'], recovered['answerCount'], recovered['toolCount'], recovered['toolErrors']) == (2, 2, 2, 0), recovered
    for tool in recovered['toolIdentities']:
        assert tool['inputSha256'] == SAMPLE_SHA256, tool
        assert tool['engineSha256'] == manifest['binarySha256'], tool
        assert tool['exitCode'] == 0, tool
    reopened = stage('recover')
    for key in ('conversationId', 'userCount', 'answerCount', 'toolCount', 'toolErrors', 'toolIdentities'):
        assert reopened[key] == recovered[key], (key, reopened, recovered)
    assert len({item['pid'] for item in evidence['stages']}) == 4, evidence
    evidence['model'] = adb('shell', 'getprop', 'ro.product.model').strip()
    evidence['selinux'] = adb('shell', 'getenforce').strip()
    assert evidence['selinux'] == 'Enforcing', evidence['selinux']
    evidence['appProcess'] = adb('shell', 'ps', '-p', str(evidence['stages'][-1]['pid']), '-o', 'UID,LABEL,NAME').strip()
    identity = evidence['appProcess'].splitlines()[-1].split()
    assert int(identity[0]) >= 10000 and 'untrusted_app' in identity[1] and identity[2] == PACKAGE, identity
    evidence['verified'] = True
    directory = ROOT / 'target/arxd/evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    if args.screenshot:
        image = subprocess.run(['adb', '-s', args.serial, 'exec-out', 'screencap', '-p'], capture_output=True, check=True).stdout
        (directory / 'arxd.png').write_bytes(image)
    print(json.dumps({'verified': True, 'evidence': str(directory), 'conversationId': recovered['conversationId']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
