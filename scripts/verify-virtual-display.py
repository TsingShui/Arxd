#!/usr/bin/env python3
"""Exercise the shipped shell controller on an explicitly selected physical device.

This is USB-host ADB verification, NOT proof of Arxd's in-app wireless pairing.
Only the dedicated, permission-free vdfixture app is launched. No input injection.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import select
import shlex
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = 'art.tsingshui.arxd.vdfixture'
PREFIX = b'ARXD_VD_V1 '


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='art.tsingshui.arxd.adbtest')
    parser.add_argument('--output', type=Path, default=ROOT / 'target/virtual-display/evidence')
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Use an isolated Arxd application ID, not the production package')
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / 'target'):
        parser.error('Evidence must be stored under root target/')
    output.mkdir(parents=True, exist_ok=True)
    adb_prefix = ['adb', '-s', args.serial]

    def adb(*command):
        result = subprocess.run(adb_prefix + list(command), capture_output=True, text=True, timeout=20, check=True)
        return result.stdout.strip()

    apk_lines = adb('shell', 'pm', 'path', args.package).splitlines()
    if len(apk_lines) != 1 or not apk_lines[0].startswith('package:'):
        raise RuntimeError('Install the isolated, unsplit Arxd test APK first')
    if not adb('shell', 'pm', 'path', FIXTURE).startswith('package:'):
        raise RuntimeError('Install tests/fixtures/virtual-display first (see its README)')
    apk = apk_lines[0].removeprefix('package:')
    command = 'CLASSPATH=' + shlex.quote(apk) + ' /system/bin/app_process /system/bin expo.modules.arxdrxd.display.DisplayServer'

    class Controller:
        def __init__(self):
            self.token = str(uuid.uuid4())
            self.proc = subprocess.Popen(adb_prefix + ['shell', '-T', command], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            self.buffer = bytearray()

        def send(self, op, **fields):
            data = {'op': op, 'protocol': 1, 'token': self.token, **fields}
            self.proc.stdin.write((json.dumps(data) + '\n').encode())
            self.proc.stdin.flush()

        def start(self):
            self.send('start', packageName=FIXTURE, component=FIXTURE + '/.MainActivity',
                      width=720, height=1280, densityDpi=320)
            return self.read()

        def read(self, timeout=20):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if b'\n' in self.buffer:
                    line, _, remaining = self.buffer.partition(b'\n')
                    self.buffer[:] = remaining
                    if line.startswith(PREFIX):
                        result = json.loads(line[len(PREFIX):])
                        assert result['protocol'] == 1
                        if result.get('ok'):
                            assert result['token'] == self.token
                        return result
                    continue
                if not select.select([self.proc.stdout], [], [], max(0, until - time.monotonic()))[0]:
                    break
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError('Controller closed without a protocol reply')
                self.buffer.extend(chunk)
                if len(self.buffer) > 2 * 1024 * 1024:
                    raise RuntimeError('Controller response exceeded its budget')
            raise TimeoutError('Controller reply timed out')

        def finish(self):
            if not self.proc.stdin.closed:
                self.proc.stdin.close()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.terminate()  # Closing the host transport causes remote stdin EOF.
                self.proc.wait(timeout=5)
                raise

    def removed(controller):
        name = 'Arxd VD ' + controller.token
        for _ in range(30):
            displays = adb('shell', 'dumpsys', 'display')
            tasks = adb('shell', 'dumpsys', 'activity', 'activities')
            if name not in displays and FIXTURE + '/' not in tasks:
                return True
            time.sleep(.15)
        return False

    def verified(ready):
        assert ready['ok'] and ready['phase'] == 'running'
        assert ready['uid'] == 2000 and ready['displayId'] > 0 and ready['taskId'] > 0
        assert ready['packageName'] == FIXTURE and ready['topActivity'].startswith(FIXTURE + '/')

    report = {
        'transport': 'USB host ADB; in-app wireless pairing is NOT verified by this script',
        'device': {'kind': 'physical', 'model': adb('shell', 'getprop', 'ro.product.model'),
                   'sdk': adb('shell', 'getprop', 'ro.build.version.sdk')},
        'applicationId': args.package, 'target': FIXTURE,
        'simulator': 'not run', 'cases': [],
    }
    focus_before = re.search(r'mTopFocusedDisplayId=(\d+)', adb('shell', 'dumpsys', 'window'))
    first = Controller()
    try:
        ready = first.start()
        verified(ready)
        displays = adb('shell', 'dumpsys', 'display')
        assert 'Arxd VD ' + first.token in displays
        activities = adb('shell', 'dumpsys', 'activity', 'activities')
        current_display = None
        associated = False
        evidence = []
        for line in activities.splitlines():
            match = re.search(r'Display #(\d+)', line)
            if match:
                current_display = int(match[1])
            if FIXTURE + '/' in line:
                evidence.append(line.strip())
                if current_display == ready['displayId']:
                    associated = True
        assert associated, 'External ActivityManager dump did not associate the fixture with the requested display'
        focus_after = re.search(r'mTopFocusedDisplayId=(\d+)', adb('shell', 'dumpsys', 'window'))
        assert focus_before and focus_after and focus_before.group(1) == focus_after.group(1)
        report['primaryFocus'] = {'before': int(focus_before.group(1)), 'during': int(focus_after.group(1))}
        report['cases'].append({'name': 'virtual display does not steal physical top focus', 'passed': True})
        report['running'] = ready
        report['taskEvidence'] = evidence
        report['displayEvidence'] = [line.strip() for line in displays.splitlines() if first.token in line]
        for _ in range(5):
            first.send('snapshot')
            frame = first.read()
            if frame.get('image'):
                data = base64.b64decode(frame['image'], validate=True)
                assert data.startswith(b'\xff\xd8') and len(data) <= 1024 * 1024
                (output / 'virtual-display.jpg').write_bytes(data)
                break
            assert frame.get('error') == 'no_frame'
            time.sleep(.2)
        else:
            raise AssertionError('No fixture preview frame')
        report['cases'].append({'name': 'real display, app task and captured frame', 'passed': True})
        second = Controller()
        try:
            refusal = second.start()
            assert not refusal['ok'] and refusal['error'] == 'app_running'
            first.send('status')
            assert first.read()['taskId'] == ready['taskId']
            report['cases'].append({'name': 'existing app task is not moved, cleared or force-stopped', 'passed': True})
        finally:
            second.finish()
        first.send('stop')
        assert first.read()['phase'] == 'stopped'
    finally:
        first.finish()
    assert removed(first)
    report['cases'].append({'name': 'stop destroys display and its task', 'passed': True})

    lost = Controller()
    try:
        verified(lost.start())
    finally:
        lost.finish()  # EOF, without a stop request.
    assert removed(lost)
    report['cases'].append({'name': 'transport EOF releases display and task', 'passed': True})

    cancelled = Controller()
    try:
        cancelled.send('start', packageName=FIXTURE, component=FIXTURE + '/.MainActivity',
                       width=720, height=1280, densityDpi=320)
    finally:
        cancelled.finish()
    assert removed(cancelled)
    report['cases'].append({'name': 'startup cancellation leaves no display or task', 'passed': True})

    expired = Controller()
    try:
        verified(expired.start())
        expired.proc.wait(timeout=40)  # Deliberately no heartbeat; the 30s lease must expire.
    finally:
        expired.finish()
    assert removed(expired)
    report['cases'].append({'name': 'unrefreshed controller lease expires and cleans up', 'passed': True})
    report['passed'] = True
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': True, 'cases': len(report['cases']), 'evidence': str(output),
                      'displayId': ready['displayId'], 'taskId': ready['taskId'], 'uid': ready['uid']}))


if __name__ == '__main__':
    main()
