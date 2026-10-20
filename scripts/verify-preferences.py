#!/usr/bin/env python3
"""Verify preference refactoring and real rxd results across physical-device processes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid

from android_reports import read_reports

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--apk', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Use an isolated verification package, not the product App')
    directory = ROOT / 'target/arxd/preferences-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    proof = {'verified': False, 'package': args.package, 'deviceKind': 'physical',
             'mode': 'offline-deterministic/real-android-pi-sqlite-rxd',
             'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'stages': []}

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True,
                                text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def save():
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')

    def launch(action, event, stage):
        adb('shell', 'am', 'force-stop', args.package)
        # Each explicit cold start must obtain a different Linux process.
        assert not adb('shell', f'pidof {shlex.quote(args.package)} || true').strip()
        url = f'arxd:///?action={action}&requestId={uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
            '-d', shlex.quote(url), '-n', args.package + '/.MainActivity')
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            pid = adb('shell', f'pidof {shlex.quote(args.package)} || true').strip()
            if not pid:
                time.sleep(.25)
                continue
            logs = adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S')
            for report in read_reports(logs):
                if report.get('event') == 'arxd-verification' and report.get('stage') == 'error':
                    raise AssertionError(report)
                if report.get('event') == event and report.get('stage') == stage:
                    assert report['verified'], report
                    assert report['engine']['processId'] == int(pid), report
                    assert report['engine']['available'] and not report['engine']['debuggable'], report
                    proof['stages'].append({'pid': int(pid), **report})
                    save()
                    print(json.dumps({'stage': stage, 'checks': len(report['checks']), 'pid': int(pid)}), flush=True)
                    return report
            time.sleep(.25)
        (directory / 'timeout-logcat.txt').write_text(logs if 'logs' in locals() else 'No running process')
        raise AssertionError('No completed verification report for ' + action)

    try:
        assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() != '1', 'A physical device is required'
        proof['model'] = adb('shell', 'getprop', 'ro.product.model').strip()
        proof['sdk'] = adb('shell', 'getprop', 'ro.build.version.sdk').strip()
        proof['selinux'] = adb('shell', 'getenforce').strip()
        assert proof['selinux'] == 'Enforcing'
        adb('install', '-r', str(args.apk))
        seed = launch('ui-preferences', 'arxd-preferences', 'seed')
        reopened = launch('ui-preferences-reopen', 'arxd-preferences', 'reopen')
        reopened_again = launch('ui-preferences-reopen', 'arxd-preferences', 'reopen')
        assert len({item['pid'] for item in proof['stages']}) == 3, 'Expected three distinct App processes'
        for key in ['active', 'thinking', 'appearance', 'motion', 'importLimit', 'toolCount', 'mode']:
            assert seed[key] == reopened[key] == reopened_again[key], key
        assert seed['toolCount'] >= 1 and seed['thinking'] == 'high'
        assert (seed['appearance'], seed['motion'], seed['importLimit']) == ('dark', 'reduced', 2 * 1024 * 1024)
        assert seed['engine']['engineSha256'] == reopened['engine']['engineSha256'] == reopened_again['engine']['engineSha256']
        # Reports can precede the Android launch-splash exit animation.
        time.sleep(1)
        (directory / 'reopened.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        proof['verified'] = True
    finally:
        save()
        print(json.dumps({'verified': proof['verified'], 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
