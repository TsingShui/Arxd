#!/usr/bin/env python3
"""Verify installed-application APK-set import on an explicitly selected device.

The App lists real PackageManager applications, imports one base APK plus its
split APKs, analyzes the captured bytes with the bundled rxd CLI, and reports
digests. This driver then re-reads the installed files independently through adb
and requires the same bytes. It never signs in, never uploads an APK and only
touches the isolated verification package it was given.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ACTION = 'ui-installed-apps-probe'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--package', default='art.tsingshui.arxd.installed')
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        raise SystemExit('Refusing a non-isolated verification package')
    assert args.apk.is_file(), f'APK missing: {args.apk}'

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=180)
        if result.returncode:
            raise RuntimeError(str(result.stderr) if not binary else 'adb failed')
        return result.stdout

    def reports(pid):
        lines = adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines() if pid else []
        parsed = []
        for line in lines:
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return parsed

    def wait_report(deadline):
        checked = 0.0
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', args.package).strip()
            for item in reversed(reports(pid)):
                if item.get('event') == 'arxd-installed-apps':
                    return item
                if item.get('event') == 'arxd-error':
                    raise AssertionError(item.get('text', 'App reported an error')[:1000])
            if time.monotonic() - checked > 5:
                checked = time.monotonic()
                failures = [line for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'AndroidRuntime:E', '*:S').splitlines() if 'FATAL' in line or 'Exception' in line]
                if failures:
                    raise AssertionError(failures[-1][:1000])
            time.sleep(1)
        raise AssertionError('No arxd-installed-apps report within the timeout')

    def installed_digests(package):
        paths = [line.removeprefix('package:').strip() for line in adb('shell', 'pm', 'path', package).splitlines() if line.strip()]
        assert paths, f'No installed APKs for {package}'
        digests = {}
        for path in paths:
            value = adb('shell', 'sha256sum', path).split()[0]
            assert re.fullmatch(r'[a-f0-9]{64}', value), value
            digests[path] = value
        return digests

    adb('install', '-r', str(args.apk))
    assert 'Success' in adb('shell', 'pm', 'clear', args.package)
    request = uuid.uuid4()
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
        '-d', shlex.quote(f'arxd:///?action={ACTION}&requestId={request}'), '-n', shlex.quote(f'{args.package}/.MainActivity'))
    report = wait_report(time.monotonic() + args.timeout)
    if not report.get('verified'):
        raise AssertionError(json.dumps(report)[:1500])
    target = report['target']
    digests = installed_digests(target['packageName'])
    expected = set(digests.values())
    actual = set(report['apkSha256'])
    assert len(digests) == target['apkCount'], (len(digests), target['apkCount'])
    assert actual == expected, {'installed': sorted(expected), 'captured': sorted(actual)}
    assert len(report['apkSha256']) == len(actual) == target['apkCount'], 'Captured digests are unique and complete'
    assert report['resolvedCount'] == target['apkCount'], report['resolvedCount']
    assert report['baseSha256'] in actual, 'Base digest belongs to the captured set'
    report['installedPaths'] = sorted(digests)
    report['independentVerification'] = 'adb sha256sum of every installed APK equals the captured set'
    report['device'] = adb('shell', 'getprop', 'ro.product.model').strip()
    report['androidVersion'] = adb('shell', 'getprop', 'ro.build.version.release').strip()
    report['apkSha256'] = hashlib.sha256(args.apk.read_bytes()).hexdigest()
    directory = ROOT / 'target/arxd/installed-apps-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    (directory / 'proof.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'verified': True, 'evidence': str(directory), 'package': target['packageName'],
                      'apkCount': target['apkCount'], 'checks': len(report['checks'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
