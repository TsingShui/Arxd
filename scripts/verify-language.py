#!/usr/bin/env python3
"""Exercise the real language menu and cold-process persistence on a connected phone.

Requires the current app to be installed and the screen unlocked. The original
language choice is restored; model requests and credentials are never touched.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='art.tsingshui.arxd')
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd(?:\.[a-z][a-z0-9_]*)?', args.package):
        parser.error('Expected an Arxd package')
    directory = ROOT / 'target/arxd/language-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    proof = {'verified': False, 'package': args.package, 'mode': 'actual-ui/real-pi-sqlite/no-model-requests', 'checks': [], 'processes': []}

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=60)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def nodes():
        path = '/data/local/tmp/arxd-language-ui.xml'
        for _ in range(3):
            result = adb('shell', 'uiautomator', 'dump', path)
            if 'dumped to:' in result:
                return list(ET.fromstring(adb('exec-out', 'cat', path)).iter('node'))
            time.sleep(.4)
        raise AssertionError('No fresh UI hierarchy')

    def by_id(identity, view=None):
        return next((node for node in (nodes() if view is None else view) if node.get('resource-id') == identity), None)

    def tap(identity):
        for _ in range(5):
            node = by_id(identity)
            if node is not None and node.get('enabled') != 'false':
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                if x2 > x1 and y2 > y1:
                    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                    time.sleep(.35)
                    return
            time.sleep(.3)
        raise AssertionError('Missing UI control: ' + identity)

    def launch(path='settings', cold=False):
        if cold:
            adb('shell', 'am', 'force-stop', args.package)
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://' + path), '-n', args.package + '/.MainActivity')
        time.sleep(.7)
        pid = int(adb('shell', 'pidof', args.package).strip())
        if cold:
            assert pid not in proof['processes'], 'Expected a new Linux process'
            proof['processes'].append(pid)
        return pid

    def open_menu():
        if by_id('language-en') is None:
            tap('settings-language')
        view = nodes()
        assert all(by_id('language-' + value, view) is not None for value in ['system', 'zh', 'en'])
        return view

    def selected():
        view = open_menu()
        choices = [value for value in ['system', 'zh', 'en'] if by_id('language-' + value, view).get('checked') == 'true']
        assert len(choices) == 1, choices
        return choices[0]

    def choose(value):
        open_menu()
        tap('language-' + value)
        assert by_id('language-en') is None, 'Language menu did not dismiss'

    def screenshot(name):
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))

    def assert_settings(title):
        assert any(node.get('text') == title for node in nodes()), 'Settings did not translate immediately'
        assert by_id('settings-language') is not None

    original = None
    try:
        proof['model'] = adb('shell', 'getprop', 'ro.product.model').strip()
        proof['deviceKind'] = 'emulator' if adb('shell', 'getprop', 'ro.kernel.qemu').strip() == '1' else 'physical'
        launch(cold=True)
        original = selected()
        screenshot('language-menu-initial')
        tap('settings-back')
        assert by_id('settings-language') is not None and by_id('language-en') is None
        proof['checks'].append('Back dismisses the borderless language layer without leaving Settings')
        choose('en')
        assert_settings('Settings')
        screenshot('settings-english')
        launch(cold=True)
        assert_settings('Settings')
        assert selected() == 'en'
        screenshot('language-menu-english')
        proof['checks'].append('English override renders on the native UI and survives a cold process')
        tap('settings-back')
        launch('models?local=1')
        view = nodes()
        def bounds(node):
            return tuple(map(int, re.findall(r'-?\d+', node.get('bounds'))))
        tabs = [next(node for node in view if node.get('content-desc') == label) for label in ['API', 'Accounts', 'Local models']]
        width = max(bounds(node)[2] for node in view)
        margin = bounds(tabs[0])[0]
        assert len({bounds(node)[1] for node in tabs}) == 1, 'Model tabs wrapped'
        assert all(bounds(node)[2] <= width - margin for node in tabs), 'Model tabs overflow the content gutter'
        screenshot('models-english')
        proof['checks'].append('English model tabs remain on one line, including their counts, inside the content gutter')
        launch()
        choose('zh')
        assert_settings('设置')
        launch(cold=True)
        assert_settings('设置')
        assert selected() == 'zh'
        screenshot('language-menu-chinese')
        proof['checks'].append('Chinese override renders on the native UI and survives a cold process')
        choose('system')
        launch(cold=True)
        assert selected() == 'system'
        proof['checks'].append('Following Android is separately remembered after a cold process')
        proof['verified'] = True
    finally:
        try:
            if original is not None:
                launch()
                choose(original)
                proof['restoredLanguage'] = original
        finally:
            (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'verified': proof['verified'], 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
