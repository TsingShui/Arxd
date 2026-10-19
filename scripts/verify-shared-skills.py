#!/usr/bin/env python3
"""Android shared-skills acceptance, against an already installed isolated test APK."""
from android_reports import read_reports
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True, help='Dedicated acceptance package; never use a user-data package')
    parser.add_argument('--apk', required=True, type=Path)
    args = parser.parse_args()
    if not args.package.startswith('art.tsingshui.arxd.'):
        parser.error('Use an isolated Arxd acceptance package, not the user App')
    evidence = ROOT / 'target/arxd/shared-skills-evidence' / str(uuid.uuid4())
    evidence.mkdir(parents=True)
    proof = {'verified': False, 'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'package': args.package, 'serial': args.serial, 'mode': 'offline-deterministic/real-android-shell-native-sqlite-pi'}

    def adb(*command, binary=False):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=90)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def launch(action=None, route=''):
        suffix = f'?action={action}&requestId={uuid.uuid4()}' if action else ''
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://' + (route or '/') + suffix), '-n', args.package + '/.MainActivity')

    def report(event, stage=None):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', args.package).strip()
            for value in reversed(read_reports(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S'))):
                if value.get('event') == event and (stage is None or value.get('stage') == stage):
                    return value
                if value.get('event') == 'arxd-runtime-error':
                    (evidence / 'runtime-errors.log').open('a').write(json.dumps(value) + '\n')
            time.sleep(.5)
        raise AssertionError('Missing Android report: ' + event)

    def nodes():
        destination = '/data/local/tmp/arxd-shared-skills-ui.xml'
        adb('shell', 'uiautomator', 'dump', destination)
        return list(ET.fromstring(adb('exec-out', 'cat', destination)).iter('node'))

    def tap(*labels):
        for node in nodes():
            if any(label in (node.get('text'), node.get('content-desc')) for label in labels):
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                if x2 > x1 and y2 > y1:
                    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); time.sleep(.4); return
        raise AssertionError('Missing UI control: ' + str(labels))

    try:
        proof['device'] = {key: adb('shell', 'getprop', prop).strip() for key, prop in [('model', 'ro.product.model'), ('os', 'ro.build.version.release'), ('sdk', 'ro.build.version.sdk'), ('abi', 'ro.product.cpu.abi')]}
        proof['packageDump'] = adb('shell', 'dumpsys', 'package', args.package)
        adb('shell', 'am', 'force-stop', args.package)
        launch('ui-shared-skills-probe')
        proof['native'] = report('arxd-shared-skills')
        assert proof['native']['verified']
        report('arxd-ui', 'ui-shared-skills-probe')
        fixture = proof['native']['fixture']
        launch('ui-shared-skills-pending')
        proof['pending'] = report('arxd-shared-skills-pending')
        assert proof['pending']['verified']
        adb('shell', 'am', 'force-stop', args.package)
        launch('ui-shared-skills-recover-pending')
        proof['recovered'] = report('arxd-shared-skills-recovered')
        assert proof['recovered']['verified']
        report('arxd-ui', 'ui-shared-skills-recover-pending')
        # Close the real consumer/storage owner, write from the actual App shell,
        # then require a new App process to reconcile events it could not consume.
        launch('ui-shared-skills-stage-restart')
        proof['restartStage'] = report('arxd-shared-skills-stage-restart')
        assert proof['restartStage']['verified']
        adb('shell', 'am', 'force-stop', args.package)
        launch('ui-shared-skills-reopen')
        proof['reopen'] = report('arxd-shared-skills-reopen')
        assert proof['reopen']['verified']
        report('arxd-ui', 'ui-shared-skills-reopen')
        launch(route='skills'); time.sleep(1)
        tap('查看技能 ' + fixture['name'], 'View skill ' + fixture['name'])
        (evidence / 'shared-skill-detail.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        assert any(node.get('text') in ('已停用', 'Disabled') or node.get('content-desc') in ('启用技能', 'Enable skill') for node in nodes())
        tap('启用技能', 'Enable skill'); tap('停用技能', 'Disable skill')
        tap('编辑技能说明', 'Edit skill instructions'); time.sleep(.3)
        assert any(node.get('class') == 'android.widget.EditText' and fixture['name'] in node.get('text', '') for node in nodes())
        adb('shell', 'input', 'keyevent', '4')
        tap('返回', 'Back'); time.sleep(.3)
        launch(route='skills'); time.sleep(.3)
        tap('查看技能 ' + fixture['name'], 'View skill ' + fixture['name'])
        tap('删除技能', 'Delete skill'); tap('删除', 'Delete')
        proof['uiChecks'] = ['Automatically discovered skill detail', 'Desired disabled state visible after restart', 'Enable and disable shared skill', 'Edit canonical SKILL.md in existing editor', 'Delete skill through management UI']
        proof['verified'] = True
    finally:
        (evidence / 'final.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        (evidence / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'verified': proof['verified'], 'evidence': str(evidence)}), flush=True)


if __name__ == '__main__':
    main()
