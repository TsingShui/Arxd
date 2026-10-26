#!/usr/bin/env python3
"""Opt-in paid DeepSeek Flash checks on an unlocked physical Arxd device."""
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
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--key-file', required=True, type=Path)
    args = parser.parse_args()
    secret = args.key_file.read_text().strip()
    adb_bin = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))
    directory = ROOT / 'target/arxd/live-android' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    with zipfile.ZipFile(apk) as archive:
        assert all(secret.encode() not in archive.read(n) for n in archive.namelist() if not n.endswith('/')), 'Credential embedded in APK'
    proof = {'verified': False, 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'credentialEmbeddedInApk': False, 'stages': []}

    def adb(*command, binary=False, check=True):
        result = subprocess.run([adb_bin, '-s', args.serial, *command], capture_output=True, text=not binary, timeout=120)
        if check and result.returncode:
            raise RuntimeError((str(result.stderr) + str(result.stdout)).replace(secret, '[REDACTED]'))
        return result.stdout

    def save():
        value = json.dumps(proof, ensure_ascii=False, indent=2)
        assert secret not in value, 'Credential leaked into evidence'
        (directory / 'proof.json').write_text(value + '\n')

    def shot(name):
        time.sleep(.6)
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def nodes():
        path = '/data/local/tmp/arxd-live-ui.xml'
        adb('shell', 'uiautomator', 'dump', path)
        data = adb('exec-out', 'cat', path)
        adb('shell', 'rm', path)
        assert secret not in data, 'Password appeared in accessibility data'
        return list(ET.fromstring(data).iter('node'))

    controls = {}

    def tap(label, editor=False):
        for node in nodes():
            if editor and node.get('class') != 'android.widget.EditText':
                continue
            if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')):
                a, b, c, d = map(int, re.findall(r'\d+', node.get('bounds')))
                if c <= a or d <= b:
                    continue
                controls[label] = (str((a + c) // 2), str((b + d) // 2))
                adb('shell', 'input', 'tap', *controls[label])
                time.sleep(.4)
                return
        raise AssertionError('Missing UI control: ' + label)

    def events():
        pid = adb('shell', 'pidof', PACKAGE, check=False).strip()
        if not pid:
            return []
        result = []
        for line in adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S').splitlines():
            try:
                result.append({'pid': int(pid), **json.loads(line)})
            except (json.JSONDecodeError, TypeError):
                pass
        return result

    def wait(stage, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in reversed(events()):
                if event.get('event') == 'arxd-ui' and event.get('stage') == stage:
                    proof['stages'].append(event)
                    save()
                    print(json.dumps({'stage': stage, 'model': event.get('modelId'), 'status': event.get('lastStatus'), 'tools': [t['name'] for t in event.get('lastTools', [])]}), flush=True)
                    return event
            time.sleep(.25)
        shot('failure')
        raise AssertionError('No report for ' + stage)

    def stage(action):
        adb('shell', 'am', 'force-stop', PACKAGE)
        url = f'arxd:///?action={action}&requestId={uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', PACKAGE + '/.MainActivity')
        return wait(action)

    try:
        adb('install', '-r', str(apk))
        stage('ui-new')
        tap('向 Arxd 提问')
        # Resolve a normal composer location for stop, without waiting for a busy spinner.
        for n in nodes():
            if n.get('resource-id') == 'send-message':
                a, b, c, d = map(int, re.findall(r'\d+', n.get('bounds')))
                controls['stop'] = (str((a + c) // 2), str((b + d) // 2))
        adb('shell', 'input', 'keyevent', '4')
        # Use the composer bounds after the keyboard has disappeared.
        for n in nodes():
            if n.get('resource-id') == 'send-message':
                a, b, c, d = map(int, re.findall(r'\d+', n.get('bounds')))
                controls['stop'] = (str((a + c) // 2), str((b + d) // 2))
        tap('选择模型')
        tap('管理连接与模型')
        tap('DeepSeek')
        tap('管理凭据')
        tap('API Key', editor=True)
        # Never put the key into a deep link, artifact or report. The password
        # field prevents it appearing in screenshots/accessibility dumps.
        adb('shell', 'input', 'text', secret)
        adb('shell', 'input', 'keyevent', '4')
        tap('保存凭据')
        tap('用于当前会话')

        chat = stage('ui-live-chat')
        assert chat['modelId'] == 'deepseek-flash' and chat['provider'] == 'deepseek'
        assert chat['lastStatus'] == 'done' and 'ARXD_FLASH_7419' in chat['lastAnswer']
        samples = max((e.get('samples', 0) for e in events() if e.get('event') == 'arxd-live-stream'), default=0)
        assert samples >= 2, 'No incrementally visible response'
        proof['streamSamples'] = samples
        proof['hermesProxyPropertyKeys'] = next(e['keys'] for e in events() if e.get('event') == 'arxd-hermes-proxy')
        shot('streamed-chat')
        reopened = stage('ui-live-reopen')
        assert reopened['active'] == chat['active'] and reopened['lastAnswer'] == chat['lastAnswer']
        follow = stage('ui-live-followup')
        assert 'ARXD_FLASH_7419' in follow['lastAnswer'] and follow['turnCount'] == chat['turnCount'] + 1
        rxd = stage('ui-live-rxd')
        assert rxd['lastStatus'] == 'done' and 'actualPhoneEntry' in rxd['entities']
        assert any(t['name'] in ('shell', 'codemode') and not t['isError'] for t in rxd['lastTools'])
        shot('rxd-result')
        shell = stage('ui-live-shell')
        assert shell['lastStatus'] == 'done'
        proof['recoveredShellErrors'] = shell['toolErrors']
        computations = [r for t in shell['lastTools'] for r in t['computations']]
        assert any(r.get('python') == 42 for r in computations)
        assert any(r.get('node') == 56 for r in computations)
        assert any('liveShellEntry' in t['functions'] for t in shell['lastTools'])
        assert all(t['identity']['packageName'] == PACKAGE and not t['identity']['debuggable'] for t in shell['lastTools'] if t['name'] == 'shell')
        shot('shell-result')
        failure = stage('ui-live-error')
        assert failure['lastStatus'] == 'failed' and any(t['isError'] and t.get('exitCode') == 23 for t in failure['lastTools'])
        assert '23' in failure['lastAnswer']

        stage('ui-live-cancel')
        deadline = time.monotonic() + 30
        child = None
        while time.monotonic() < deadline:
            for line in adb('shell', 'ps', '-A', '-o', 'PID,UID,ARGS').splitlines():
                if PACKAGE in line and re.search(r'\bsleep 30$', line):
                    child = line.split()[0]
            if child:
                break
            time.sleep(.2)
        assert child, 'Model did not start the requested real child'
        before_stop = time.monotonic()
        adb('shell', 'input', 'tap', *controls['stop'])
        stopped = wait('ui-stopped', timeout=15)
        proof['shellStopMs'] = round((time.monotonic() - before_stop) * 1000)
        assert not stopped['busy'] and stopped['lastStatus'] == 'stopped'
        assert child not in adb('shell', 'ps', '-A', '-o', 'PID').split()
        proof['cancelledChildPid'] = int(child)
        assert stage('ui-live-reopen')['lastStatus'] == 'stopped'

        stage('ui-live-stream-stop')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(e.get('event') == 'arxd-live-stream' and e.get('samples', 0) >= 2 for e in events()):
                break
            time.sleep(.2)
        else:
            raise AssertionError('No live stream to abort')
        before_stop = time.monotonic()
        adb('shell', 'input', 'tap', *controls['stop'])
        assert wait('ui-stopped', timeout=15)['lastStatus'] == 'stopped'
        proof['streamStopMs'] = round((time.monotonic() - before_stop) * 1000)
        shot('stopped-stream')
        assert stage('ui-live-reopen')['lastStatus'] == 'stopped'
        crash = stage('ui-live-stream-crash')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(e.get('event') == 'arxd-live-stream' and e.get('samples', 0) >= 2 for e in events()):
                break
            time.sleep(.2)
        else:
            raise AssertionError('No in-flight generation to interrupt')
        resumed = stage('ui-live-reopen')
        assert resumed['active'] == crash['active'] and resumed['turnCount'] == crash['turnCount']
        assert resumed['lastStatus'] == 'done' and 'RECOVERED_FLASH' in resumed['lastAnswer']
        again = stage('ui-live-reopen')
        assert again['lastAnswer'] == resumed['lastAnswer'] and again['turnCount'] == resumed['turnCount']
        stage('ui-new')
        proof['verified'] = True
        shutil.copyfile(apk, directory / 'verified.apk')
        save()
        print(json.dumps({'verified': True, 'evidence': str(directory)}), flush=True)
    except Exception as error:
        proof['error'] = str(error).replace(secret, '[REDACTED]')
        save()
        raise RuntimeError(proof['error']) from None
    finally:
        adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-n', PACKAGE + '/.MainActivity')


if __name__ == '__main__':
    main()
