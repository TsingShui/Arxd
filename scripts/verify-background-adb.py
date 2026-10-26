#!/usr/bin/env python3
"""Verify real background Pi/SQLite + Termux adb against the permission-free fixture.

Install a verification-enabled isolated Arxd APK and tests/fixtures/virtual-display.
The CLI must already be installed. Default: use Arxd's configured adb connection.
--relay-port selects an explicitly prepared HOST-ASSISTED transport, NOT evidence
of in-App wireless pairing. No Wi-Fi/debugging settings are changed by this runner.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = 'art.tsingshui.arxd.vdfixture'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='art.tsingshui.arxd.adbtest')
    parser.add_argument('--relay-port', type=int)
    parser.add_argument('--output', type=Path, default=ROOT / 'target/adb-shell/evidence')
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Only an isolated verification App package is allowed')
    if args.relay_port is not None and not 1 <= args.relay_port <= 65535:
        parser.error('Invalid explicitly prepared host-assisted relay port')
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / 'target'):
        parser.error('Evidence must be stored under root target/')
    output.mkdir(parents=True, exist_ok=True)
    prefix = ['adb', '-s', args.serial]

    def adb(*command):
        return subprocess.check_output(prefix + list(command), text=True, timeout=25).strip()

    def launch(action='run', script=None):
        parameters = {'action': action, 'request': str(uuid.uuid4())}
        if script is not None:
            parameters['scriptHex'] = script.encode().hex()
        uri = 'arxd://verify-background?' + urllib.parse.urlencode(parameters, quote_via=urllib.parse.quote)
        adb('shell', 'am start -W -n ' + args.package + '/.MainActivity -a android.intent.action.VIEW -d ' + shlex.quote(uri))

    def reports():
        groups, result = {}, []
        for line in adb('logcat', '-d', '-s', 'ArxdVerify:I', '-v', 'brief').splitlines():
            try:
                item = json.loads(line[line.index('{'):])
            except (ValueError, json.JSONDecodeError):
                continue
            if item.get('event') == 'arxd-background-chunk':
                group = groups.setdefault(item['messageId'], {})
                group[item['index']] = item['data']
                if len(group) == item['parts']:
                    result.append(json.loads(''.join(group[i] for i in range(item['parts']))))
            elif item.get('event') == 'arxd-background-verification':
                result.append(item)
        return result

    def wait(stage, timeout=100):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = reports()
            error = next((item for item in current if item['stage'] == 'error'), None)
            if error:
                raise RuntimeError(error)
            found = [item for item in current if item['stage'] == stage]
            if found:
                return found[-1]
            time.sleep(.25)
        raise TimeoutError(stage)

    def ui():
        adb('shell', 'uiautomator dump /data/local/tmp/arxd-background-fixture.xml')
        return adb('shell', 'cat /data/local/tmp/arxd-background-fixture.xml')

    def center(node):
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
        assert x2 > x1 and y2 > y1, 'The device must be unlocked with the fixture visible'
        return (x1 + x2) // 2, (y1 + y2) // 2

    for package in (args.package, FIXTURE):
        assert adb('shell', 'pm', 'path', package).startswith('package:')
    wireless = adb('shell', 'settings get global adb_wifi_enabled')
    report = {'passed': False, 'device': {'kind': 'physical', 'model': adb('shell', 'getprop ro.product.model'),
              'sdk': adb('shell', 'getprop ro.build.version.sdk')}, 'package': args.package,
              'provider': 'offline-deterministic-not-live', 'simulator': 'not run',
              'transport': 'host-assisted adb relay; wireless pairing NOT verified' if args.relay_port else 'configured in-App CLI connection; pairing ceremony is a separate test', 'cases': []}
    try:
        # This is our own permission-free fixture, never an arbitrary installed App.
        adb('shell', 'am force-stop ' + FIXTURE)
        adb('shell', 'am start -W --windowingMode 1 -n ' + FIXTURE + '/.MainActivity')
        before = ui()
        tree = ET.fromstring(before)
        tap = center(next(n for n in tree.iter('node') if n.get('content-desc') == 'fixture-tap'))
        edit = center(next(n for n in tree.iter('node') if n.get('content-desc') == 'fixture-input'))
        client = 'adb' if args.relay_port is None else 'adb -H 127.0.0.1 -P ' + str(args.relay_port) + ' -s ' + shlex.quote(args.serial)
        script = f'''set -eu
id -u
d() {{ {client} "$@"; }}
d shell id -u
sleep 7
d shell am start -W --windowingMode 1 -n {FIXTURE}/.MainActivity
sleep 2
d shell input tap {tap[0]} {tap[1]}
d shell input tap {edit[0]} {edit[1]}
d shell input text ARXD_ADB_42
d shell input keyevent KEYCODE_BACK
d exec-out screencap -p > "$ARXD_WORKSPACE/adb-background.png"
python - <<'PY'
import os,pathlib,struct,hashlib,json
b=(pathlib.Path(os.environ['ARXD_WORKSPACE'])/'adb-background.png').read_bytes()
assert b[:8]==b'\\x89PNG\\r\\n\\x1a\\n'
print(json.dumps({{'pngBytes':len(b),'dimensions':struct.unpack('>II',b[16:24]),'sha256':hashlib.sha256(b).hexdigest()}}))
PY
printf 'BACKGROUND_ADB_DONE\\n'
'''
        adb('logcat', '-c')
        launch(script=script)
        wait('shell-started')
        adb('shell', 'input keyevent KEYCODE_HOME')
        time.sleep(.5)
        services = adb('shell', 'dumpsys', 'activity', 'services', args.package)
        assert 'AgentSessionService' in services and 'isForeground=true' in services
        complete = wait('complete')
        wait('closed')
        tool = complete['value']['tools'][-1]
        assert not tool['isError'], tool
        assert complete['value']['appState'] == 'background'
        assert '\n2000\n' in tool['details']['stdout'] and 'BACKGROUND_ADB_DONE' in tool['details']['stdout']
        after = ui()
        assert 'ARXD_ADB_42' in after and 'TAP COUNT: 1' in after
        assert 'AgentSessionService' not in adb('shell', 'dumpsys', 'activity', 'services', args.package)
        (output / 'background-result.json').write_text(json.dumps(complete, indent=2))
        (output / 'fixture-before.xml').write_text(before)
        (output / 'fixture-after.xml').write_text(after)
        (output / 'background-services.txt').write_text(services)
        (output / 'foreground-fixture.png').write_bytes(subprocess.check_output(prefix + ['exec-out', 'screencap', '-p']))
        report['cases'] = ['real Termux adb UID', 'foreground notification service while UI is background',
                           'background App launch', 'tap and ASCII text in fixture', 'real PNG screenshot',
                           'background JS timer and durable model completion', 'foreground lease released']
        report['passed'] = True
    finally:
        report['wirelessDebuggingBefore'] = wireless
        report['wirelessDebuggingAfter'] = adb('shell', 'settings get global adb_wifi_enabled')
        assert report['wirelessDebuggingAfter'] == wireless, 'Wireless debugging state changed during test'
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'cases': len(report['cases']), 'evidence': str(output)}))


if __name__ == '__main__':
    main()
