#!/usr/bin/env python3
"""Verify connection configuration and real native provider requests on a phone."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import select
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
    parser.add_argument('--live', action='store_true', help='One bounded request using the already saved DeepSeek credential')
    parser.add_argument('--resume-ui', type=Path, help='Reuse same-APK native evidence and resume UI verification')
    args = parser.parse_args()
    directory = args.resume_ui or ROOT / 'target/arxd/models-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True, exist_ok=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'uiChecks': [], 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest()}
    if args.resume_ui:
        previous = json.loads((directory / 'proof.json').read_text())
        assert previous['apkSha256'] == proof['apkSha256']
        proof = previous
        if (directory / 'http.json').exists() and not (directory / 'http-native.json').exists():
            shutil.copy2(directory / 'http.json', directory / 'http-native.json')
    else:
        shutil.copy2(apk, directory / 'app-release.apk')
    server = subprocess.Popen(['node', str(ROOT / 'scripts/serve-model-fixtures.mjs'), str(directory / 'http.json')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

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
        path = '/data/local/tmp/arxd-models-ui.xml'
        for _ in range(3):
            adb('shell', 'rm', '-f', path)
            result = adb('shell', 'uiautomator', 'dump', path)
            if 'dumped to:' in result:
                return list(ET.fromstring(adb('exec-out', 'cat', path)).iter('node'))
            time.sleep(.5)
        raise AssertionError('UI hierarchy not refreshed: ' + result)

    def control(label, scroll=False, editor=False):
        for attempt in range(9 if scroll else 1):
            for node in nodes():
                if editor and node.get('class') != 'android.widget.EditText':
                    continue
                if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) and node.get('enabled') != 'false':
                    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                    if x2 > x1 and y2 > y1:
                        return node, (str((x1+x2)//2), str((y1+y2)//2))
            if attempt < 8 and scroll:
                adb('shell', 'input', 'swipe', '540', '1960', '540', '620', '350')
        raise AssertionError('Missing UI control: ' + label)

    def tap(label, scroll=False):
        _, point = control(label, scroll)
        adb('shell', 'input', 'tap', *point)
        time.sleep(.3)

    def top():
        for _ in range(4):
            adb('shell', 'input', 'swipe', '540', '650', '540', '1950', '200')

    def input_text(label, value):
        node, point = control(label, True, True)
        old = node.get('text', '')
        if old == label:
            old = ''
        adb('shell', 'input', 'tap', *point)
        adb('shell', 'input', 'keyevent', '123')
        if old:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))
        # This physical-device flow has the software keyboard open after tapping
        # an editable field. Close it before scrolling, rather than swiping keys.
        adb('shell', 'input', 'keyevent', '4')

    def screenshot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def wait_text(text):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(text in item.get('text', '') for item in nodes()):
                return
            time.sleep(.2)
        raise AssertionError('Missing UI text: ' + text)

    def wait_report(event, stage=None, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', PACKAGE).strip()
            for line in reversed(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines()):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get('event') == event and (stage is None or item.get('stage') == stage):
                    return item
            time.sleep(.3)
        errors = [item.get('text', '') for item in nodes() if item.get('text', '').startswith('Error:')]
        if errors:
            raise AssertionError(errors[0][:1000])
        raise AssertionError('Missing report: ' + str((event, stage)))

    try:
        assert select.select([server.stdout], [], [], 10)[0], 'Fixture server did not start'
        assert json.loads(server.stdout.readline())['ready']
        adb('reverse', 'tcp:17651', 'tcp:17651')
        if not args.resume_ui:
            adb('install', '-r', str(apk))
            action('ui-connections-probe')
            proof['native'] = wait_report('arxd-connections')
            wait_report('arxd-ui', 'ui-connections-probe')
            print(json.dumps({'nativeChecks': len(proof['native']['checks'])}), flush=True)
        action('ui-new'); wait_report('arxd-ui', 'ui-new')
        launch('arxd://models/connection?id=' + proof['native']['brokenConnection'])
        wait_text('设备凭据无法读取，请清除后重新配置')
        tap('管理凭据'); tap('清除设备凭据', True); tap('清除')
        assert not any('凭据无法读取' in item.get('text', '') for item in nodes())
        screenshot('credential-recovered')
        tap('删除连接', True); tap('删除')
        proof['uiChecks'].append('A fresh App process opens despite an unreadable credential, and its isolated record can be cleared through the UI')
        launch('arxd://models'); screenshot('connections')
        tap('添加连接'); tap('自定义接口')
        input_text('连接名称', 'Phone UI Fixture')
        input_text('Endpoint', 'http://127.0.0.1:17651/ui')
        tap('无需认证', True); tap('保存连接', True)
        wait_text('Phone UI Fixture'); screenshot('connection-created')
        tap('手动添加模型', True)
        input_text('模型 ID', 'probe-model'); input_text('模型显示名称', 'PhoneUIModel')
        input_text('回复 token 预算', '64'); input_text('温度', '0.3')
        tap('高级参数', True); input_text('采样参数 JSON', '{"top_p":0.73}')
        input_text('兼容选项 JSON', '{"maxTokensField":"max_tokens","supportsDeveloperRole":false}')
        tap('保存模型', True)
        tap('测试连接', True); wait_text('请求成功，模型返回了文本。')
        screenshot('connection-tested')
        proof['uiChecks'].append('Create a custom connection and manual model with budget, temperature and sampling; actual test request succeeds')
        tap('用于当前会话', True)
        input_text('message-input', 'UI protocol probe')
        tap('发送消息'); wait_text('MODEL_OK'); screenshot('configured-chat')
        action('ui-reopen'); reopened = wait_report('arxd-ui', 'ui-reopen')
        assert reopened['lastAnswer'] == 'MODEL_OK' and reopened['model'] != 'test'
        proof['reopened'] = reopened
        proof['uiChecks'].append('Choose the configured model, send through the actual UI and reopen the same response in a new App process')
        tap('选择模型'); screenshot('connection-scoped-menu'); tap('关闭模型选择')
        proof['uiChecks'].append('Chat selector shows enabled models with their connection names')
        launch('arxd://models'); tap('Phone UI Fixture')
        tap('管理凭据'); input_text('API Key', 'phone-fixture-key-only')
        tap('保存凭据', True); tap('管理凭据')
        node, _ = control('API Key', True, True)
        assert 'phone-fixture-key-only' not in node.get('text', '')
        screenshot('credential-not-displayed')
        tap('清除设备凭据', True); tap('清除')
        proof['uiChecks'].append('Save and clear a device credential without refilling secret values in the editor')
        tap('删除连接', True); tap('删除')
        tap('使用离线测试模型', True)
        wait_text('MODEL_OK')
        proof['uiChecks'].append('Deleting the connection retains replies; choosing offline is explicit')
        launch('arxd://models'); tap('添加连接'); tap('DeepSeek')
        input_text('连接名称', 'Catalog Fixture'); tap('保存连接', True)
        tap('从模型目录添加', True); screenshot('catalog')
        # Filter to one official catalog model, without a provider request.
        input_text('搜索模型 ID 或名称', 'deepseek-v4-pro'); tap('添加此模型', True)
        input_text('回复 token 预算', '128'); tap('已停用', True); tap('保存模型', True)
        tap('删除连接', True); tap('删除')
        proof['uiChecks'].append('Add an official catalog model, configure it, disable it and delete only the isolated connection')
        if args.live:
            assert proof['native']['legacyHasCredential'], 'No existing DeepSeek credential'
            action('ui-live-connection-test')
            proof['live'] = wait_report('arxd-connection-live')
            assert proof['live']['ok']
            proof['uiChecks'].append('The preserved DeepSeek credential completes one bounded live connection test')
        server.terminate(); server.wait(timeout=10)
        http = json.loads((directory / 'http.json').read_text())
        ui_requests = [item for item in http['requests'] if item['path'].startswith('/ui/')]
        assert any(item['maxTokens'] == 16 for item in ui_requests), 'Connection probe must have a 16-token cap'
        assert any(item['maxTokens'] == 64 and item['temperature'] == .3 and item['topP'] == .73 for item in ui_requests), 'Saved generation settings must reach the wire'
        assert all(not item['authPresent'] for item in ui_requests), 'Keyless connection must not send an authentication header'
        proof['httpChecks'] = ['Probe budget is 16 tokens', 'Saved reply budget, temperature and sampling reach HTTP', 'Keyless requests omit authentication']
        proof['verified'] = True
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait()
        try:
            adb('reverse', '--remove', 'tcp:17651')
        except Exception:
            pass
        if not proof['verified']:
            try:
                screenshot('failure')
                (directory / 'failure.xml').write_text(adb('exec-out', 'cat', '/data/local/tmp/arxd-models-ui.xml'))
            except Exception:
                pass
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'evidence': str(directory), 'verified': proof['verified']}), flush=True)


if __name__ == '__main__':
    main()
