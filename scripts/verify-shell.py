#!/usr/bin/env python3
"""Verify Pi's real Android shell tool and unsafe-replay recovery without clearing App data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--timeout', type=int, default=60)
    args = parser.parse_args()
    adb_bin = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))

    def adb(*command, check=True):
        result = subprocess.run([adb_bin, '-s', args.serial, *command], capture_output=True, text=True, timeout=120)
        if check and result.returncode:
            raise RuntimeError(result.stderr + result.stdout)
        return result.stdout

    directory = ROOT / 'target/arxd/shell-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    evidence = {'verified': False, 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'stages': []}
    with zipfile.ZipFile(apk) as archive:
        manifest = json.loads(archive.read('assets/termux-bootstrap.json'))
    evidence['manifest'] = manifest
    adb('install', '-r', str(apk))

    def save():
        (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')

    def stage(action):
        adb('shell', 'am', 'force-stop', PACKAGE)
        url = f'arxd://verify?action={action}&requestId=shell-{uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', f'{PACKAGE}/.MainActivity')
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE, check=False).strip()
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
                        evidence['stages'].append({'pid': int(pid), **report})
                        save()
                        print(json.dumps({'stage': action, 'pid': pid, 'count': report.get('count'), 'toolCount': report.get('toolCount')}), flush=True)
                        return report
            time.sleep(0.5)
        raise AssertionError(f'No {action} UI report; App may need manual unlock; evidence: {directory}')

    initial = stage('recover')
    before = stage('shell-inspect')['count']
    completed = stage('shell')
    assert completed['conversationId'] == initial['conversationId']
    assert completed['toolCount'] == initial['toolCount'] + 1
    assert completed['toolErrors'] == initial['toolErrors']
    tool = completed['toolIdentities'][-1]
    assert tool['tool'] == 'shell' and tool['exitCode'] == 0 and tool['python'] == 42 and tool['node'] == 56 and tool['rxdFunction']
    assert tool['shellCount'] == before + 1 and tool['identity']['uid'] >= 10000
    assert tool['identity']['packageName'] == PACKAGE and tool['identity']['debuggable'] is False
    assert tool['identity']['pid'] == evidence['stages'][-1]['pid']
    assert tool['identity']['shimSha256'] == manifest['shimSha256']
    reopened = stage('recover')
    for key in ('conversationId', 'userCount', 'answerCount', 'toolCount', 'toolErrors', 'toolIdentities'):
        assert reopened[key] == completed[key], key
    checkpoint = stage('shell-checkpoint')
    assert checkpoint['exitCode'] == 0
    assert stage('shell-inspect')['count'] == before + 2
    recovered = stage('recover')
    assert recovered['conversationId'] == initial['conversationId']
    for key in ('userCount', 'answerCount', 'toolCount'):
        assert recovered[key] == initial[key] + 2, key
    assert recovered['toolErrors'] == initial['toolErrors'] + 1
    assert recovered['toolIdentities'][-1]['interrupted'] is True
    assert stage('shell-inspect')['count'] == before + 2
    again = stage('recover')
    for key in ('conversationId', 'userCount', 'answerCount', 'toolCount', 'toolErrors', 'toolIdentities'):
        assert again[key] == recovered[key], key
    assert len({s['pid'] for s in evidence['stages']}) == len(evidence['stages'])
    evidence['selinux'] = adb('shell', 'getenforce').strip()
    assert evidence['selinux'] == 'Enforcing'
    evidence['verified'] = True
    save()
    print(json.dumps({'verified': True, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
