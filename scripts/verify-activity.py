#!/usr/bin/env python3
"""Verify live activity on a connected phone using its saved DeepSeek credential."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--live', action='store_true', required=True, help='Authorize the bounded live model request; a key must already be saved on the phone')
    args = parser.parse_args()
    directory = ROOT / 'target/arxd/activity-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'mode': 'live-model/real-managed-shell', 'phases': [], 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest()}
    shutil.copy2(apk, directory / 'app-release.apk')

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def shot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def launch(action):
        adb('shell', 'am', 'force-stop', PACKAGE)
        url = f'arxd:///?action={action}&requestId={uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', PACKAGE + '/.MainActivity')

    def reports():
        pid = adb('shell', 'pidof', PACKAGE).strip()
        if not pid:
            return []
        result = []
        for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return result

    try:
        adb('install', '-r', str(apk))
        launch('ui-activity-unicode')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            preview = next((item for item in reports() if item.get('event') == 'arxd-native-preview'), None)
            if preview:
                proof['nativePreview'] = preview
                assert preview['verified']
                break
            time.sleep(.2)
        else:
            raise AssertionError('No native UTF-8 preview report')
        launch('ui-live-activity')
        seen = set()
        finished = None
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            for report in reports():
                if report.get('event') == 'arxd-activity':
                    key = (report.get('phase'), report.get('status'), report.get('preview'))
                    if key not in seen:
                        seen.add(key)
                        proof['phases'].append(report)
                        print(json.dumps(report), flush=True)
                        if report.get('phase') == 'thinking' and not (directory / 'thinking.png').exists():
                            shot('thinking')
                        if report.get('preview') and not (directory / 'live-tool.png').exists():
                            shot('live-tool')
                if report.get('event') == 'arxd-ui' and report.get('stage') == 'ui-live-finished':
                    finished = report
            if finished:
                break
            time.sleep(.2)
        if not finished:
            shot('failure')
            raise AssertionError('No completed live activity report; check the saved credential and unlocked screen')
        proof['finished'] = finished
        assert finished['lastStatus'] == 'done' and finished['provider'] == 'deepseek'
        assert any(item.get('phase') == 'thinking' for item in proof['phases'])
        assert any(item.get('runningTools', 0) > 0 for item in proof['phases'])
        assert any(item.get('preview') for item in proof['phases'])
        assert any(item['kind'] == 'thinking' for item in finished['activity'])
        tool = finished['lastTools'][-1]
        assert not tool['isError'] and tool['exitCode'] == 0
        assert 'activity-first-✓' in tool['outputPreview'] and 'activity-last-✓' in tool['outputPreview']
        assert tool['durationMs'] >= 0
        assert any(item['kind'] == 'thinking' and item.get('durationMs', 0) > 0 for item in finished['timing']['phases'])
        shot('completed')
        launch('ui-reopen')
        deadline = time.monotonic() + 30
        reopened = None
        while time.monotonic() < deadline:
            reopened = next((item for item in reports() if item.get('stage') == 'ui-reopen'), None)
            if reopened:
                break
            time.sleep(.2)
        assert reopened and reopened['active'] == finished['active'] and reopened['lastStatus'] == 'done'
        assert reopened['timing'] == finished['timing']
        assert reopened['lastTools'] == finished['lastTools']
        proof['reopened'] = reopened
        shot('reopened')
        proof['verified'] = True
    finally:
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'evidence': str(directory), 'verified': proof['verified']}), flush=True)


if __name__ == '__main__':
    main()
