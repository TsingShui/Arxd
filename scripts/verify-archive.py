#!/usr/bin/env python3
"""Verify archive/search/restore and retained resources on a connected phone, offline."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    args = parser.parse_args()
    directory = ROOT / 'target/arxd/archive-evidence' / str(uuid.uuid4()); directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'uiChecks': [], 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest()}
    shutil.copy2(apk, directory / 'app-release.apk')

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str((result.returncode, result.stderr)))
        return result.stdout

    def launch(url, restart=False):
        if restart:
            adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', PACKAGE + '/.MainActivity'); time.sleep(.6)

    def action(name):
        launch(f'arxd:///?action={name}&requestId={uuid.uuid4()}', True)

    def nodes():
        path = '/data/local/tmp/arxd-archive-ui.xml'
        for _ in range(5):
            adb('shell', 'rm', '-f', path)
            try:
                result = adb('shell', 'uiautomator', 'dump', path)
                if 'dumped to:' in result:
                    return list(ET.fromstring(adb('exec-out', 'cat', path)).iter('node'))
            except RuntimeError:
                pass
        raise AssertionError('No current UI hierarchy')

    def tap(label):
        candidates = []
        for node in nodes():
            if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) and node.get('enabled') != 'false':
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                if x2 > x1 and y2 > y1:
                    candidates.append(((x2-x1)*(y2-y1), str((x1+x2)//2), str((y1+y2)//2)))
        if not candidates:
            raise AssertionError('Missing UI control: ' + label)
        _, x, y = min(candidates); adb('shell', 'input', 'tap', x, y); time.sleep(.25)

    def input_text(label, value):
        node = next(item for item in nodes() if item.get('class') == 'android.widget.EditText' and label in (item.get('content-desc'), item.get('resource-id')))
        old = node.get('text', '')
        if old == label:
            old = ''
        tap(label); adb('shell', 'input', 'keyevent', '123')
        if old:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s'))); adb('shell', 'input', 'keyevent', '4')

    def report(event, stage=None):
        deadline = time.monotonic() + 65
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE).strip()
            for line in reversed(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines()):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get('event') == event and (stage is None or item.get('stage') == stage):
                    return item
            time.sleep(.25)
        raise AssertionError('Missing report: ' + str((event, stage)))

    def shot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def wait_text(text):
        for _ in range(10):
            if any(text in item.get('text', '') for item in nodes()):
                return
        raise AssertionError('Missing text: ' + text)

    try:
        adb('install', '-r', str(apk)); action('ui-archive-probe')
        proof['native'] = report('arxd-archive'); report('arxd-ui', 'ui-archive-probe')
        fixture = proof['native']['fixture']; cid = str(fixture['id'])
        print(json.dumps({'nativeChecks': len(proof['native']['checks'])}), flush=True)
        tap('打开对话历史'); tap('归档会话')
        input_text('搜索归档会话', fixture['title']); wait_text(fixture['title']); shot('archive-search')
        tap('archive-open-' + cid); wait_text('此会话已归档；发送消息会恢复。')
        action('ui-reopen'); reopened = report('arxd-ui', 'ui-reopen')
        assert reopened['active'] == fixture['id'] and reopened['archived'] and reopened['fileCount'] == 1
        proof['uiChecks'].append('Search and open archive, then reopen its preserved history/files in a fresh process without restoring')
        input_text('message-input', 'ArchiveUIResume'); tap('发送消息')
        for _ in range(15):
            if not any(item.get('resource-id') == 'stop-analysis' for item in nodes()):
                break
        action('ui-reopen'); restored = report('arxd-ui', 'ui-reopen')
        assert restored['active'] == fixture['id'] and not restored['archived'] and restored['turnCount'] == reopened['turnCount'] + 1 and restored['lastStatus'] == 'done'
        proof['uiChecks'].append('Sending restores the same archived conversation before admission')
        tap('更多'); tap('归档此会话')
        launch('arxd://archive'); input_text('搜索归档会话', fixture['title']); tap('archive-restore-' + cid)
        wait_text('没有匹配的归档会话'); shot('explicit-restore')
        action('ui-reopen'); assert not report('arxd-ui', 'ui-reopen')['archived']
        proof['uiChecks'].append('Explicit restore removes the row from archive and persists across a process restart')
        launch('arxd://files'); tap('文件库')
        for name in [fixture['fileName'], fixture['savedName']]:
            input_text('搜索文件名', name); tap('查看文件 ' + name); shot('retained-' + ('capture' if name.endswith('.js') else 'report')); tap('返回')
        proof['uiChecks'].append('Capture and saved report remain independently discoverable')
        proof['verified'] = True
    finally:
        if not proof['verified']:
            try:
                shot('failure'); (directory / 'failure.xml').write_text(adb('exec-out', 'cat', '/data/local/tmp/arxd-archive-ui.xml'))
            except Exception:
                pass
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n'); print(json.dumps({'evidence': str(directory), 'verified': proof['verified']}), flush=True)


if __name__ == '__main__':
    main()
