#!/usr/bin/env python3
"""Verify native skill storage and sidebar workflows on a connected phone, offline."""
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
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--resume-directory-picker', type=Path, help='Resume only the picker flow from same-APK evidence')
    args = parser.parse_args()
    directory = args.resume_directory_picker or ROOT / 'target/arxd/skills-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True, exist_ok=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'mode': 'offline-deterministic/real-android-native-and-pi', 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'uiChecks': []}
    if args.resume_directory_picker:
        previous = json.loads((directory / 'proof.json').read_text())
        assert previous['apkSha256'] == proof['apkSha256']
        proof = previous
    else:
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
        time.sleep(.5)

    def action(name):
        launch(f'arxd:///?action={name}&requestId={uuid.uuid4()}', True)

    def nodes():
        adb('shell', 'rm', '-f', '/data/local/tmp/arxd-skills-ui.xml')
        result = adb('shell', 'uiautomator', 'dump', '/data/local/tmp/arxd-skills-ui.xml')
        if 'dumped to:' not in result:
            raise AssertionError('UI hierarchy was not refreshed: ' + result)
        return list(ET.fromstring(adb('exec-out', 'cat', '/data/local/tmp/arxd-skills-ui.xml')).iter('node'))

    def tap(label, resource=None):
        for node in nodes():
            if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) and node.get('enabled') != 'false' and (resource is None or node.get('resource-id') == resource):
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                if x2 <= x1 or y2 <= y1:
                    continue
                adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                time.sleep(.3)
                return
        raise AssertionError('Missing UI control: ' + label)

    def input_text(label, value, append=False):
        node = next(item for item in nodes() if label in (item.get('content-desc'), item.get('resource-id')))
        old = node.get('text', '')
        if old == label:
            old = ''
        tap(label)
        adb('shell', 'input', 'keyevent', '123')
        if old and not append:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))

    def screenshot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def wait_report(event, stage=None):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE).strip()
            for line in reversed(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines()):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get('event') == event and (stage is None or item.get('stage') == stage):
                    return item
            errors = [item.get('text', '') for item in nodes() if item.get('text', '').startswith('Error:')]
            if errors:
                raise AssertionError(errors[0][:1000])
            time.sleep(.3)
        raise AssertionError('Missing report: ' + str((event, stage)))

    def open_skill(name):
        launch('arxd://skills')
        if any(item.get('content-desc') == '搜索技能' for item in nodes()):
            tap('搜索技能')
            input_text('搜索技能', name)
            tap('查看技能 ' + name)

    try:
        if not args.resume_directory_picker:
            adb('install', '-r', str(apk))
            action('ui-skills-probe')
            proof['native'] = wait_report('arxd-skills')
            assert proof['native']['verified']
            print(json.dumps({'nativeChecks': len(proof['native']['checks'])}), flush=True)
            action('ui-new'); wait_report('arxd-ui', 'ui-new')
            name = proof['native']['fixture']['name']
            open_skill(name); screenshot('imported-disabled')
            tap('启用技能'); tap('用于当前会话')
            assert any(item.get('content-desc') == '取消技能选择 ' + name for item in nodes())
            assert not any(item.get('resource-id') == 'stop-analysis' for item in nodes())
            screenshot('selected-without-send')
            proof['uiChecks'].append('Enable and select skill without automatically submitting a task')
            action('ui-reopen'); wait_report('arxd-ui', 'ui-reopen')
            assert any(item.get('content-desc') == '取消技能选择 ' + name for item in nodes())
            proof['uiChecks'].append('Conversation skill selection survives a new App process')
            open_skill(name); tap('编辑技能说明')
            input_text('技能说明内容', 'UI_EDITED', append=True)
            tap('保存技能'); screenshot('definition-saved')
            tap('管理脚本与资源'); tap('打开 SKILL.md')
            assert any('UI_EDITED' in item.get('text', '') for item in nodes())
            screenshot('shared-file-resources')
            proof['uiChecks'].append('Edit SKILL.md and inspect the same managed resource through the file manager')
            open_skill(name)
            tap('停用技能'); tap('取消会话选择')
            tap('删除技能'); tap('删除')
            screenshot('skill-deleted')
            proof['uiChecks'].append('Disable, unselect and delete through the sidebar without deleting history')
        # Exercise archive import through the actual Android document picker.
        fixture = proof.get('externalFixture') or 'arxd-saf-skill-' + uuid.uuid4().hex[:8]
        source = directory / fixture
        (source / 'references').mkdir(parents=True, exist_ok=True)
        (source / 'SKILL.md').write_text('---\nname: saf-skill-probe\ndescription: Archive import verification fixture.\n---\nRead references/guide.md.\n')
        (source / 'references/guide.md').write_text('ZIP_RESOURCE_IDENTITY')
        archive = directory / (fixture + '.zip')
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(source.rglob('*')):
                if path.is_file():
                    bundle.write(path, str(path.relative_to(source)))
        adb('push', str(archive), '/sdcard/Download/' + fixture + '.zip')
        proof['externalFixture'] = fixture
        launch('arxd://skills', True)
        tap('导入技能')
        screenshot('archive-picker')
        try:
            tap(fixture + '.zip')
        except AssertionError:
            tap('显示根目录')
            tap('Pixel 10', 'android:id/title')
            tap('Download', 'android:id/title')
            tap(fixture + '.zip')
        assert any(item.get('text') == 'saf-skill-probe' for item in nodes())
        tap('管理脚本与资源'); tap('打开 references'); tap('打开 guide.md')
        assert any(item.get('text') == 'ZIP_RESOURCE_IDENTITY' for item in nodes())
        proof['uiChecks'].append('Import a real ZIP skill package with nested references and verify resource bytes')
        open_skill('saf-skill-probe'); tap('删除技能'); tap('删除')
        # The same header action still accepts a standalone SKILL.md.
        tap('导入技能')
        try:
            tap('SKILL.md')
        except AssertionError:
            tap('显示根目录')
            tap('Pixel 10', 'android:id/title')
            tap('Download', 'android:id/title')
            tap(fixture)
            tap('SKILL.md')
        assert any(item.get('text') == 'saf-skill-probe' for item in nodes())
        screenshot('single-definition-imported')
        proof['uiChecks'].append('Import a standalone SKILL.md through the actual Android document picker')
        tap('删除技能'); tap('删除')
        adb('shell', 'rm', '-f', '/sdcard/Download/' + fixture + '.zip')
        adb('shell', 'rm', '-rf', '/sdcard/Download/' + fixture)
        launch('arxd://files'); tap('工作区')
        input_text('搜索文件名', proof['native']['fixture']['directory'])
        tap('管理 ' + proof['native']['fixture']['directory']); tap('删除文件'); tap('删除')
        proof['verified'] = True
    finally:
        if not proof['verified']:
            try:
                screenshot('failure')
                (directory / 'failure.xml').write_text(adb('exec-out', 'cat', '/data/local/tmp/arxd-skills-ui.xml'))
            except Exception:
                pass
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'evidence': str(directory), 'verified': proof['verified']}), flush=True)


if __name__ == '__main__':
    main()
