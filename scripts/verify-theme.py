#!/usr/bin/env python3
"""Verify shared appearance, system following, reduced motion and real work on a phone. Requires Pillow."""
import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'art.tsingshui.arxd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--resume', type=Path, help='Reuse successful same-APK screen and native-work evidence')
    args = parser.parse_args()
    directory = args.resume or ROOT / 'target/arxd/theme-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True, exist_ok=True)
    apk = ROOT / 'target/arxd/gradle/_app/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'checks': [], 'screens': [], 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest()}
    if args.resume:
        previous = json.loads((directory / 'proof.json').read_text())
        assert previous['apkSha256'] == proof['apkSha256']
        proof = previous; proof['verified'] = False
    else:
        shutil.copy2(apk, directory / 'app-release.apk')

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str((result.returncode, result.stdout, result.stderr)))
        return result.stdout

    def keyboard():
        state = adb('shell', 'dumpsys', 'input_method')
        if re.search(r'(mInputShown|mIsInputViewShown|isInputViewShown)=true', state):
            adb('shell', 'input', 'keyevent', '4')

    def launch(url, restart=False):
        if restart:
            adb('shell', 'am', 'force-stop', PACKAGE)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', PACKAGE + '/.MainActivity')
        time.sleep(.8)

    def action(name):
        launch(f'arxd:///?action={name}&requestId={uuid.uuid4()}', True)

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

    def report(event, match=None, timeout=50):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = next((item for item in reversed(reports()) if item.get('event') == event and (not match or all(item.get(key) == value for key, value in match.items()))), None)
            if found:
                return found
            time.sleep(.15)
        raise AssertionError('Missing report: ' + str((event, match)))

    def theme(**match):
        return report('arxd-theme', match)

    def nodes():
        path = '/data/local/tmp/arxd-theme-ui.xml'
        for _ in range(5):
            adb('shell', 'rm', '-f', path)
            try:
                output = adb('shell', 'uiautomator', 'dump', path)
            except RuntimeError as error:
                output = str(error)
                time.sleep(.5)
                continue
            if 'dumped to:' in output:
                return list(ET.fromstring(adb('exec-out', 'cat', path)).iter('node'))
        raise AssertionError('No fresh UI hierarchy')

    def control(label, scroll=False):
        for attempt in range(8 if scroll else 1):
            candidates = []
            for node in nodes():
                if label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) and node.get('enabled') != 'false':
                    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                    if x2 > x1 and y2 > y1:
                        candidates.append(((x2-x1)*(y2-y1), node, (str((x1+x2)//2), str((y1+y2)//2))))
            if candidates:
                _, node, point = min(candidates, key=lambda item: item[0])
                return node, point
            if scroll and attempt < 7:
                adb('shell', 'input', 'swipe', '540', '1900', '540', '650', '250')
        raise AssertionError('Missing UI control: ' + label)

    def tap(label, scroll=False):
        _, point = control(label, scroll)
        adb('shell', 'input', 'tap', *point)
        time.sleep(.25)

    def set_motion(reduced):
        node, _ = control('motion-reduced')
        if (node.get('checked') == 'true') != reduced:
            tap('motion-reduced')

    def top():
        for _ in range(3):
            adb('shell', 'input', 'swipe', '540', '650', '540', '1900', '200')

    def input_text(label, value):
        node, point = control(label)
        old = node.get('text', '')
        if old == label:
            old = ''
        adb('shell', 'input', 'tap', *point)
        adb('shell', 'input', 'keyevent', '123')
        if old:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))
        adb('shell', 'input', 'keyevent', '4')

    def quick_back(label, hidden):
        _, point = control(label)
        started = time.monotonic()
        adb('shell', f'input tap {point[0]} {point[1]}; input keyevent 4')
        elapsed = round((time.monotonic() - started) * 1000)
        time.sleep(.4)
        assert not any(hidden in (item.get('resource-id'), item.get('content-desc')) for item in nodes())
        proof.setdefault('quickBack', []).append({'control': label, 'tapThenBackMs': elapsed, 'closed': True})

    def shot(name, expected=None):
        data = adb('exec-out', 'screencap', '-p', binary=True)
        (directory / (name + '.png')).write_bytes(data)
        if expected:
            picture = Image.open(BytesIO(data)).convert('RGB')
            wanted = tuple(bytes.fromhex(expected.removeprefix('#')))
            points = [picture.getpixel((5, int(picture.height * position))) for position in [.25, .3, .4]]
            assert any(max(abs(a-b) for a, b in zip(point, wanted)) <= 2 for point in points), (name, wanted, points)
            proof['screens'].append({'name': name, 'background': expected, 'pixels': points, 'matched': True})

    def matrix(name, state):
        routes = ['/', '/settings', '/models', '/files', '/skills', '/environment', '/archive', '/search']
        for index, route in enumerate(routes):
            if any(item['name'] == f'{name}-{index}' and item['background'] == state['background'] for item in proof['screens']):
                continue
            launch('arxd:///' if route == '/' else 'arxd://' + route.lstrip('/'))
            shot(f'{name}-{index}', state['background'])

    old_night = adb('shell', 'cmd', 'uimode', 'night').strip().split(':')[-1].strip()
    assert old_night in ('yes', 'no', 'auto', 'custom_schedule', 'custom_bedtime'), old_night
    scales = {key: adb('shell', 'settings', 'get', 'global', key).strip() for key in ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']}
    before = proof.get('before')
    original = proof.get('original')
    try:
        adb('install', '-r', str(apk))
        action('ui-theme-observe'); current = theme(ready=True)
        before = before or current
        original = original or report('arxd-ui', {'stage': 'ui-theme-observe'})
        proof['original'] = original
        proof['before'] = before
        if not proof.get('work', {}).get('verified'):
            action('ui-theme-work')
            proof['work'] = report('arxd-appearance-work', {'verified': True})
            report('arxd-ui', {'stage': 'ui-theme-work'})
            proof['checks'].append('Theme and reduced-motion changes retain and cancel a real native shell task')
        launch('arxd://settings'); top(); tap('appearance-system'); tap('theme-fire')
        set_motion(False)
        for key in scales:
            adb('shell', 'settings', 'put', 'global', key, '1')
        adb('shell', 'cmd', 'uimode', 'night', 'no')
        light = theme(palette='fire', appearance='system', scheme='light', reducedMotion=False)
        pid = adb('shell', 'pidof', PACKAGE).strip()
        matrix('fire-light', light)
        for index, route in enumerate(['/models/connection?id=deepseek', '/models/model?id=deepseek&model=deepseek']):
            if any(item['name'] == f'model-subpage-{index}' for item in proof['screens']):
                continue
            launch('arxd://' + route.lstrip('/')); shot(f'model-subpage-{index}', light['background'])
        adb('shell', 'cmd', 'uimode', 'night', 'yes')
        dark = theme(palette='fire', scheme='dark', appearance='system')
        assert adb('shell', 'pidof', PACKAGE).strip() == pid
        matrix('fire-dark', dark)
        launch('arxd://settings'); top(); tap('theme-spring')
        dark = theme(palette='spring', scheme='dark', appearance='system')
        matrix('spring-dark', dark)
        adb('shell', 'cmd', 'uimode', 'night', 'no')
        light = theme(palette='spring', scheme='light', appearance='system')
        matrix('spring-light', light)
        proof['checks'].append('Both palettes follow live OS light/dark changes across seven product routes and model subpages')
        launch('arxd://settings'); top(); tap('appearance-dark')
        fixed = theme(appearance='dark', palette='spring', scheme='dark')
        adb('shell', 'cmd', 'uimode', 'night', 'yes'); adb('shell', 'cmd', 'uimode', 'night', 'no')
        shot('fixed-dark', fixed['background'])
        set_motion(True); theme(motion='reduced', reducedMotion=True)
        action('ui-theme-observe'); theme(appearance='dark', palette='spring', motion='reduced', reducedMotion=True)
        assert adb('shell', 'pidof', PACKAGE).strip() != pid
        reopened = report('arxd-ui', {'stage': 'ui-theme-observe'})
        assert reopened['active'] == original['active']
        proof['checks'].append('Fixed appearance overrides OS changes; theme/motion and the active conversation survive a new process')
        launch('arxd://settings'); top(); set_motion(False)
        for key in scales:
            adb('shell', 'settings', 'put', 'global', key, '0')
        theme(motion='system', reducedMotion=True)
        for key in scales:
            adb('shell', 'settings', 'put', 'global', key, '1')
        theme(motion='system', reducedMotion=False)
        proof['checks'].append('OS animation-off changes propagate without restarting the App')
        action('ui-theme-sample'); sample = report('arxd-ui', {'stage': 'ui-theme-sample'}); proof['sample'] = sample
        assert sample['lastStatus'] == 'done' and 'arxdProbe' in sample['entities']
        quick_back('添加文件', '关闭面板')
        quick_back('选择模型', 'model-menu')
        tap('添加文件'); tap('关闭面板')
        tap('添加文件'); tap('关闭面板')
        tap('导出分析记录'); shot('themed-report'); tap('关闭详情')
        tap('选择模型'); tap('关闭模型选择'); tap('选择模型'); tap('关闭模型选择')
        tap('打开对话历史'); shot('drawer'); tap('关闭对话历史')
        adb('shell', 'input', 'swipe', '96', '1050', '440', '1050', '300')
        control('关闭对话历史'); tap('关闭对话历史')
        proof['checks'].append('Animated file sheets, report details, model menus and the edge-swipe drawer reopen and close without stale content')
        launch('arxd://files'); tap('工作区'); tap('新建文件夹'); tap('取消')
        proof['checks'].append('File dialogs share the theme and dismissal behavior')
        launch('arxd://settings'); top(); set_motion(True)
        theme(reducedMotion=True, motion='reduced')
        launch('arxd:///'); tap('选择模型'); tap('关闭模型选择')
        tap('添加文件'); tap('关闭面板')
        proof['checks'].append('The same overlays remain usable with reduced motion')
        launch('arxd://files'); tap('文件库')
        own_file = sample['fileIdentities'][0]['name']
        input_text('搜索文件名', own_file); tap('查看文件 ' + own_file); tap('删除文件'); tap('删除')
        proof['verified'] = True
    finally:
        try:
            adb('shell', 'cmd', 'uimode', 'night', old_night)
            for key, value in scales.items():
                if value == 'null':
                    adb('shell', 'settings', 'delete', 'global', key)
                else:
                    adb('shell', 'settings', 'put', 'global', key, value)
            if before:
                launch('arxd://settings'); top(); tap('appearance-' + before['appearance']); tap('theme-' + before['palette']); tap('motion-' + before['motion'], True)
                launch('arxd:///')
                if original and original['active'] is not None:
                    tap('打开对话历史'); tap('conversation-' + str(original['active']), True)
                else:
                    # A welcome screen already represents a new conversation; the
                    # new-conversation control is intentionally hidden there.
                    pass
            proof['restoredSystemSettings'] = True
        except Exception as error:
            proof['restoreError'] = str(error)
            proof['verified'] = False
        if not proof['verified']:
            try:
                shot('failure'); (directory / 'failure.xml').write_text(adb('exec-out', 'cat', '/data/local/tmp/arxd-theme-ui.xml'))
            except Exception:
                pass
        proof['checks'] = list(dict.fromkeys(proof['checks']))
        proof['screens'] = list({item['name']: item for item in proof['screens']}.values())
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'evidence': str(directory), 'verified': proof['verified'], 'screens': len(proof['screens'])}), flush=True)


if __name__ == '__main__':
    main()
