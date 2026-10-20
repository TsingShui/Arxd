#!/usr/bin/env python3
"""Verify native file boundaries, the independent catalog and file-manager UI on a phone."""
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
    directory = ROOT / 'target/arxd/files-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'uiChecks': []}
    shutil.copy2(apk, directory / 'app-release.apk')

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def launch(url, restart=False):
        if restart:
            adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', PACKAGE + '/.MainActivity')

    def action(name):
        launch(f'arxd:///?action={name}&requestId={uuid.uuid4()}', True)

    def reports():
        pid = adb('shell', 'pidof', PACKAGE).strip()
        result = []
        for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return result

    def wait_report(event, stage=None):
        deadline = time.monotonic() + 60
        checked = time.monotonic()
        while time.monotonic() < deadline:
            match = next((item for item in reversed(reports()) if item.get('event') == event and (stage is None or item.get('stage') == stage)), None)
            if match:
                return match
            if time.monotonic() - checked > 5:
                checked = time.monotonic()
                errors = [item.get('text', '') for item in nodes() if item.get('text', '').startswith('Error:')]
                if errors:
                    raise AssertionError(errors[0][:1000])
            time.sleep(.3)
        raise AssertionError('Missing report: ' + str((event, stage)))

    def nodes():
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/arxd-files-ui.xml')
        return list(ET.fromstring(adb('exec-out', 'cat', '/data/local/tmp/arxd-files-ui.xml')).iter('node'))

    def tap(label):
        for node in nodes():
            if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) and node.get('enabled') != 'false':
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                time.sleep(.3)
                return
        raise AssertionError('Missing UI control: ' + label)

    def input_text(label, value):
        candidates = nodes()
        node = next(item for item in candidates if label in (item.get('content-desc'), item.get('resource-id')))
        old = node.get('text', '')
        if old == label:
            old = ''
        tap(label)
        adb('shell', 'input', 'keyevent', '123')
        if old:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', value)

    def screenshot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def form(label, value):
        tap(label); input_text('文件名或目标路径', value); tap('确定')

    try:
        adb('install', '-r', str(apk))
        action('ui-files-probe')
        proof['native'] = wait_report('arxd-files')
        assert proof['native']['verified']
        wait_report('arxd-ui', 'ui-files-probe')
        print(json.dumps({'nativeChecks': len(proof['native']['checks'])}), flush=True)
        # The report is assembled on demand from the turn action, never pre-materialized.
        tap('导出分析记录')
        report = next(item.get('text') for item in nodes() if (item.get('text') or '').startswith('report-') and (item.get('text') or '').endswith('.md'))
        name = report
        tap('保存到文件库')
        screenshot('saved-artifact')
        tap('关闭详情')
        action('ui-new'); wait_report('arxd-ui', 'ui-new')
        launch('arxd://files')
        input_text('搜索文件名', name)
        tap('查看文件 ' + name)
        screenshot('library-report')
        tap('分享文件'); screenshot('share-chooser'); adb('shell', 'input', 'keyevent', '4')
        tap('用于对话')
        attached_nodes = nodes()
        assert any(item.get('resource-id') == 'message-input' for item in attached_nodes)
        assert next(item for item in attached_nodes if item.get('resource-id') == 'send-message').get('enabled') == 'false', 'Library attachment must leave the empty composer unchanged'
        assert not any(item.get('resource-id') == 'stop-analysis' for item in attached_nodes)
        screenshot('attach-handoff')
        proof['uiChecks'].append('Save/share/attach a real report without submitting a message')
        action('ui-reopen'); reopened = wait_report('arxd-ui', 'ui-reopen')
        assert reopened['fileCount'] == 1 and reopened['turnCount'] == 0
        proof['reopened'] = reopened
        proof['uiChecks'].append('Attached library file survives a new App process')
        launch('arxd://files')
        tap('工作区')
        folder = 'rxd-ui-' + uuid.uuid4().hex[:8]
        form('新建文件夹', folder)
        input_text('搜索文件名', folder); tap('打开 ' + folder)
        form('新建文件', 'ui-note.txt')
        tap('打开 ui-note.txt'); tap('编辑文本')
        input_text('文件内容', 'ui-file-content')
        tap('保存更改'); screenshot('edited-file')
        tap('打开 ui-note.txt'); tap('复制到'); tap('内置环境 Home')
        copied = folder + '-copy.txt'
        input_text('文件名或目标路径', copied); tap('确定')
        tap('内置环境 Home'); input_text('搜索文件名', copied)
        tap('打开 ' + copied); screenshot('home-copy')
        assert any(item.get('text') == 'ui-file-content' for item in nodes())
        tap('删除文件'); tap('删除')
        proof['uiChecks'].append('Create/edit/copy/delete through the native file UI')
        tap('工作区'); input_text('搜索文件名', folder); tap('管理 ' + folder)
        tap('删除文件'); tap('删除')
        proof['uiChecks'].append('Delete the isolated UI folder and its contents')
        screenshot('workspace-cleaned')
        tap('环境文件（只读）'); screenshot('runtime-readonly')
        proof['uiChecks'].append('Browse the read-only runtime root')
        proof['verified'] = True
    finally:
        if not proof['verified']:
            try:
                screenshot('failure')
            except Exception:
                pass
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'evidence': str(directory), 'verified': proof['verified']}), flush=True)


if __name__ == '__main__':
    main()
