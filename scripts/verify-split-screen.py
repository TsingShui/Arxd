#!/usr/bin/env python3
"""Physical UI test: real app-UID adjacent launch, never shell-forced window modes."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = 'art.tsingshui.arxd.vdfixture'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='art.tsingshui.arxd.adbtest')
    parser.add_argument('--output', default=str(ROOT / 'target/split-screen/evidence'))
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.(adbtest|splittest)', args.package):
        raise ValueError('Only isolated display-test packages are allowed')
    out = Path(args.output).resolve()
    if not out.is_relative_to(ROOT / 'target'):
        raise ValueError('Evidence must stay under root target/')
    out.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'physical device; public API invoked by isolated App UI', 'serial': args.serial,
              'package': args.package, 'fixture': FIXTURE, 'cases': [], 'simulator': 'not run',
              'automaticScreenAnalysis': 'not implemented', 'inAppWirelessAdb': 'not exercised'}

    def adb(*argv, timeout=25):
        return subprocess.check_output(['adb', '-s', args.serial, *argv], text=True, timeout=timeout).strip()

    def dump():
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/arxd-split-test.xml')
        adb('pull', '/data/local/tmp/arxd-split-test.xml', str(out / 'ui.xml'))
        return list(ET.parse(out / 'ui.xml').iter('node'))

    def bounds(node):
        coords = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
        return coords if len(coords) == 4 and coords[2] > coords[0] and coords[3] > coords[1] else None

    def find(identity):
        return next((n for n in dump() if n.get('resource-id') == identity and bounds(n)), None)

    def wait_node(identity, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = find(identity)
            if found is not None:
                return found
        raise AssertionError('Missing visible control: ' + identity)

    def tap(identity):
        node = wait_node(identity)
        assert node.get('enabled') == 'true', identity
        x1, y1, x2, y2 = bounds(node)
        adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

    def route(name):
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', 'arxd://' + name,
            '-n', args.package + '/.MainActivity')

    def screenshot(name):
        data = subprocess.check_output(['adb', '-s', args.serial, 'exec-out', 'screencap', '-p'], timeout=15)
        (out / (name + '.png')).write_bytes(data)

    def case(name):
        report['cases'].append({'name': name, 'passed': True})

    wireless_before = adb('shell', 'settings', 'get', 'global', 'adb_wifi_enabled')
    try:
        report['sdk'] = adb('shell', 'getprop', 'ro.build.version.sdk')
        report['model'] = adb('shell', 'getprop', 'ro.product.model')
        route('experiments')
        toggle = wait_node('experiment-virtual-display')
        assert toggle.get('checked') == 'false', 'Start this test with the isolated experiment disabled'
        case('experimental Virtual Display defaults to disabled')
        route('virtual-display')
        wait_node('vd-experiments')
        assert find('vd-start') is None
        assert wait_node('vd-stop').get('enabled') == 'false'
        case('old Virtual Display deep link cannot expose disabled start')
        route('experiments')
        tap('experiment-virtual-display')
        wait_node('experiment-open-virtual-display')
        assert wait_node('experiment-virtual-display').get('checked') == 'true'
        old_pid = adb('shell', 'pidof', args.package)
        # Reopen actual Android storage in a NEW process; do not clear App data.
        adb('shell', 'am', 'force-stop', args.package)
        route('experiments')
        assert wait_node('experiment-virtual-display').get('checked') == 'true'
        new_pid = adb('shell', 'pidof', args.package)
        assert old_pid and new_pid and old_pid != new_pid
        report['restart'] = {'beforePid': old_pid, 'afterPid': new_pid, 'preference': 'retained'}
        case('experiment preference survives a real process restart')
        tap('experiment-virtual-display')
        assert wait_node('experiment-virtual-display').get('checked') == 'false'
        case('experiment can be disabled again')

        # Only our permission-free fixture is reset. No user app is force-stopped.
        adb('shell', 'am', 'force-stop', FIXTURE)
        route('split-screen')
        tap('split-search')
        adb('shell', 'input', 'text', FIXTURE)
        adb('shell', 'input', 'keyevent', 'BACK')
        tap('split-app-' + FIXTURE)
        screenshot('selected')
        tap('split-launch')
        time.sleep(2)
        activities = adb('shell', 'dumpsys', 'activity', 'activities')
        # Keep only the two test apps' ActivityRecord blocks, not unrelated task data.
        blocks = re.split(r'(?=^\s*\* Hist\s+#[0-9]+: ActivityRecord)', activities, flags=re.M)
        selected = {}
        for package in [args.package, FIXTURE]:
            own = [b for b in blocks if re.match(r'^\s*\* Hist[^\n]* ' + re.escape(package) + r'/', b)]
            assert own, 'No task for ' + package
            block = own[0].split('\n\n')[0]
            selected[package] = block
            assert 'mWindowingMode=multi-window' in block, 'Not split: ' + package
            assert re.search(r'(mVisibleRequested|visibleRequested)=true', block), 'Not visible: ' + package
        (out / 'tasks.txt').write_text('\n\n'.join(selected.values()))
        report['tasks'] = {pkg: re.search(r'ActivityRecord\{[^\n]+', block).group(0) for pkg, block in selected.items()}
        rectangles = {}
        for pkg, block in selected.items():
            match = re.search(r'taskBounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)', block)
            assert match, 'Missing independently observed window bounds: ' + pkg
            rectangles[pkg] = list(map(int, match.groups()))
        a, b = rectangles.values()
        assert min(a[2], b[2]) <= max(a[0], b[0]) or min(a[3], b[3]) <= max(a[1], b[1]), 'Windows overlap'
        launcher_uid = int(re.search(r'launchedFromUid=(\d+)', selected[FIXTURE]).group(1))
        assert launcher_uid >= 10000 and ('launchedFromPackage=' + args.package) in selected[FIXTURE]
        report['windowBounds'] = rectangles
        report['targetLaunchedFromUid'] = launcher_uid
        screenshot('split-screen')
        case('public adjacent launch places both real test tasks in visible multi-window')

        # Focus our own half, never another user app, then return to the real chat.
        x1, y1, x2, y2 = rectangles[args.package]
        adb('shell', 'input', 'tap', str((x1 + x2) // 2), str(y1 + 60))
        if find('split-conversation') is None:
            adb('shell', 'input', 'swipe', str(x2 - 30), str(y2 - 80), str(x2 - 30), str(y1 + 180), '400')
        tap('split-conversation')
        nodes = dump()
        own = [n for n in nodes if n.get('package') == args.package]
        assert any(n.get('class') == 'android.widget.EditText' for n in own), 'Actual conversation did not render'
        assert all(n.get('resource-id') != 'split-search' for n in own)
        screenshot('conversation')
        again = adb('shell', 'dumpsys', 'activity', 'activities')
        for pkg in [args.package, FIXTURE]:
            block = next(b for b in re.split(r'(?=^\s*\* Hist\s+#[0-9]+: ActivityRecord)', again, flags=re.M)
                         if re.match(r'^\s*\* Hist[^\n]* ' + re.escape(pkg) + r'/', b))
            assert 'mWindowingMode=multi-window' in block and 'mVisibleRequested=true' in block
        case('return to actual conversation without ending the adjacent app')
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['error'] = str(error)
        screenshot('failure')
        raise
    finally:
        report['wirelessBefore'] = wireless_before
        report['wirelessAfter'] = adb('shell', 'settings', 'get', 'global', 'adb_wifi_enabled')
        assert report['wirelessAfter'] == wireless_before
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'cases': len(report['cases']), 'evidence': str(out)}))


if __name__ == '__main__':
    main()
