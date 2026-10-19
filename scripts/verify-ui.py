#!/usr/bin/env python3
"""Exercise the native Arxd workspace on an unlocked physical phone, preserving App data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--timeout', type=int, default=45)
    args = parser.parse_args()
    adb_bin = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))
    directory = ROOT / 'target/arxd/ui-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    evidence = {'verified': False, 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'stages': [], 'interactions': []}
    controls = {}

    def adb(*command, binary=False, check=True):
        result = subprocess.run([adb_bin, '-s', args.serial, *command], capture_output=True, text=not binary, timeout=120)
        if check and result.returncode:
            raise RuntimeError(str(result.stderr) + str(result.stdout))
        return result.stdout

    def save():
        (directory / 'device-proof.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')

    def screenshot(name):
        time.sleep(.8)  # Let native launch/modal transitions finish before visual evidence.
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def nodes():
        path = '/data/local/tmp/arxd-ui-verification.xml'
        adb('shell', 'uiautomator', 'dump', path)
        document = adb('exec-out', 'cat', path)
        adb('shell', 'rm', path)
        return list(ET.fromstring(document).iter('node'))

    def tap(label):
        # A DocumentsUI result can repeat the query text in its search input.
        # Prefer the actual result row; explicit input labels still match below.
        for node in sorted(nodes(), key=lambda n: n.get('class') in ('android.widget.EditText', 'android.widget.AutoCompleteTextView')):
            if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')):
                values = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
                if len(values) == 4:
                    x1, y1, x2, y2 = values
                    controls[label] = (str((x1 + x2) // 2), str((y1 + y2) // 2))
                    adb('shell', 'input', 'tap', *controls[label])
                    evidence['interactions'].append(label)
                    time.sleep(.4)
                    return
        raise AssertionError(f'UI control not found: {label}; evidence: {directory}')

    def wait_report(stage):
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE, check=False).strip()
            if pid:
                lines = adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines()
                for line in reversed(lines):
                    try:
                        report = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if report.get('event') == 'arxd-ui' and report.get('stage') == stage:
                        evidence['stages'].append({'pid': int(pid), **report})
                        save()
                        print(json.dumps({'stage': stage, 'pid': pid, 'active': report['active'], 'lastStatus': report.get('lastStatus')}), flush=True)
                        return report
            time.sleep(.3)
        screenshot('failure')
        raise AssertionError(f'No {stage} report; ensure phone is unlocked; evidence: {directory}')

    def stage(action):
        adb('shell', 'am', 'force-stop', PACKAGE)
        url = f'arxd:///?action={action}&requestId=ui-{uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', f'{PACKAGE}/.MainActivity')
        return wait_report(action)

    adb('install', '-r', str(apk))
    baseline = stage('ui-reopen')
    first = stage('ui-sample')
    assert first['conversationCount'] == baseline['conversationCount'] + 1
    assert first['fileCount'] == 1 and first['turnCount'] == 1 and first['toolCount'] == 1
    assert first['lastStatus'] == 'done' and 'arxdProbe' in first['entities']
    second = stage('ui-second')
    assert second['conversationCount'] == first['conversationCount'] + 1
    assert second['active'] != first['active'] and second['lastStatus'] == 'done'
    assert 'nativeSecond' in second['entities'] and 'arxdProbe' not in second['entities']
    reopened = stage('ui-reopen')
    for key in ('active', 'conversationCount', 'fileCount', 'turnCount', 'toolCount', 'entities'):
        assert reopened[key] == second[key], key

    tap('打开对话历史')
    screenshot('history')
    tap('打开对话 分析 JavaScript 样本的结构。')
    selected = stage('ui-reopen')
    assert selected['active'] == first['active'] and selected['entities'] == first['entities']
    tap('查看证据 arxdProbe')
    screenshot('evidence')
    tap('查看文件 arxd-sample.js')
    screenshot('source')
    tap('关闭详情')

    stage('ui-spring')
    assert stage('ui-reopen')['palette'] == 'spring'
    screenshot('spring-results')
    stage('ui-new')
    screenshot('spring-welcome')
    stage('ui-fire')
    screenshot('fire-welcome')
    tap('向 Arxd 提问')
    # `input text` drops everything after a space, and a composing IME (Gboard in
    # Pinyin mode) decides what finally lands in the field, so this stage proves
    # that the composer takes focus and receives text rather than exact glyphs.
    adb('shell', 'input', 'text', 'Keyboardtest')
    time.sleep(.6)
    input_node = next(n for n in nodes() if n.get('resource-id') == 'message-input')
    assert input_node.get('text'), 'Composer did not receive the typed text'
    windows = adb('shell', 'dumpsys', 'window', 'windows')
    ime = re.search(r'Window #\d+ Window\{[^\n]+ InputMethod\}:(.*?)(?=\n  Window #|\Z)', windows, re.S)
    assert ime, 'No active input method window'
    region = re.search(r'touchable region=SkRegion\(\(\d+,(\d+),', ime[1])
    assert region, 'No keyboard touchable region'
    input_bounds = list(map(int, re.findall(r'\d+', input_node.get('bounds', ''))))
    assert input_bounds[3] <= int(region[1]), 'Composer is covered by the keyboard'
    screenshot('keyboard')
    adb('shell', 'input', 'keyevent', '4')

    # Exercise the actual composer/sample controls rather than only deep-link actions.
    tap('体验 JavaScript 样本')
    screenshot('attached-sample')
    tap('发送消息')
    sent = wait_report('ui-sent')
    assert sent['lastStatus'] == 'done' and 'arxdProbe' in sent['entities']
    screenshot('fire-results')
    tap('导出分析记录')
    screenshot('report')
    tap('分享分析产物')
    # Verify the OS chooser, then dismiss without selecting any recipient.
    assert any(n.get('package') in ('android', 'com.android.intentresolver') for n in nodes()), 'OS share sheet did not open'
    screenshot('share-sheet')
    adb('shell', 'input', 'keyevent', '4')
    tap('关闭详情')

    stage('ui-new')
    name = f'arxd-ui-{uuid.uuid4()}.js'
    source = b'export function selectedFromPhone(value) { return value * 3; }\n'
    capture = directory / name
    capture.write_bytes(source)
    phone_path = '/sdcard/Download/' + name
    try:
        adb('push', str(capture), phone_path)
        adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file://' + phone_path)
        tap('添加一个文件')
        tap('从设备选择文件')
        tap('在此设备上搜索')
        adb('shell', 'input', 'text', name[:-3])
        adb('shell', 'input', 'keyevent', '66')
        time.sleep(.6)
        tap(name)
        imported = wait_report('ui-imported')
        assert imported['fileCount'] == 1
        assert imported['fileIdentities'] == [{'name': name, 'sha256': hashlib.sha256(source).hexdigest()}]
        tap('发送消息')
        queried = wait_report('ui-sent')
        assert queried['lastStatus'] == 'done' and 'selectedFromPhone' in queried['entities']
        assert stage('ui-reopen')['fileIdentities'] == imported['fileIdentities']
        tap('查看文件 ' + name)
        assert any('export function selectedFromPhone' in n.get('text', '') for n in nodes())
        screenshot('imported-source')
        tap('关闭详情')
    finally:
        adb('shell', 'rm', phone_path)

    running = stage('ui-stop-probe')
    assert running['busy']
    time.sleep(2)
    uid = re.search(r'uid:(\d+)', adb('shell', 'cmd', 'package', 'list', 'packages', '-U', PACKAGE))
    assert uid and int(uid[1]) >= 10000
    processes = adb('shell', 'ps', '-A', '-o', 'PID,UID,ARGS').splitlines()
    sleep_children = [line.split(None, 2) for line in processes if re.search(r'\bsleep 30$', line)]
    sleep_children = [row for row in sleep_children if len(row) == 3 and row[1] == uid[1]]
    assert len(sleep_children) == 1, 'No real sleep child under the App UID'
    child_pid = sleep_children[0][0]
    evidence['cancelledChild'] = {'pid': int(child_pid), 'uid': int(uid[1])}
    # UIAutomator waits for animation idleness; a running spinner can consume
    # the entire short probe. Stop uses the same verified composer button bounds.
    screenshot('running')
    adb('shell', 'input', 'tap', *controls['发送消息'])
    evidence['interactions'].append('停止分析 (verified composer coordinates)')
    stopped = wait_report('ui-stopped')
    assert not stopped['busy'] and stopped['lastStatus'] in ('stopped', 'failed')
    assert child_pid not in adb('shell', 'ps', '-A', '-o', 'PID').split(), 'Cancelled child is still alive'
    evidence['cancelledChild']['terminated'] = True
    screenshot('stopped')
    recovered = stage('ui-reopen')
    assert not recovered['busy'] and recovered['active'] == stopped['active']
    assert recovered['lastStatus'] in ('stopped', 'failed')
    evidence['selinux'] = adb('shell', 'getenforce').strip()
    assert evidence['selinux'] == 'Enforcing'
    stage('ui-new')
    # Leave the normal screen for the owner, without test-only wake flags.
    adb('shell', 'am', 'force-stop', PACKAGE)
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-n', f'{PACKAGE}/.MainActivity')
    evidence['verified'] = True
    shutil.copyfile(apk, directory / 'verified.apk')
    save()
    print(json.dumps({'verified': True, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
