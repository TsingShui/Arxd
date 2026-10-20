#!/usr/bin/env python3
"""Verify context occupancy through the actual Android App/Pi and native composer UI."""
from android_reports import read_reports
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import subprocess
import time
from urllib.parse import quote, urlencode
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True, help='Dedicated installed acceptance package')
    parser.add_argument('--apk', required=True, type=Path)
    parser.add_argument('--resume-ui', type=Path, help='Reuse matching successful native/reopen proof and run only the real UI checks on that exact installed APK/device')
    parser.add_argument('--layout-matrix', action='store_true', help='Temporarily exercise narrow density and enlarged text; restores prior settings')
    parser.add_argument('--manual-controls-only', action='store_true', help='Only run existing manual compaction controls on the installed APK; optional --resume-ui reuses matching prior native/visual proof')
    args = parser.parse_args()
    if args.manual_controls_only and args.layout_matrix:
        parser.error('--manual-controls-only cannot include --layout-matrix')
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Use an isolated Arxd acceptance package, not the user App')
    directory = ROOT / 'target/arxd/context-capacity-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)
    scope = 'manual-controls-only' if args.manual_controls_only else 'native-and-ui'
    proof = {'verified': False, 'scope': scope, 'package': args.package, 'serial': args.serial, 'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'uiChecks': [], 'mode': 'offline-deterministic/real-android-app-pi'}

    def adb(*command, binary=False, timeout=90, diagnostic=None):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=timeout)
        if diagnostic:
            (directory / diagnostic).write_text(json.dumps({'command': command, 'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False, indent=2))
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    identity = None

    def activity_identity(timeout=15, settle=False):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'Target MainActivity identity did not settle within the foreground budget'
            dump = adb('shell', 'dumpsys', 'activity', 'activities', timeout=remaining)
            identities = set(re.findall(r'ActivityRecord\{([^\s}]+)\s+u[0-9]+\s+' + re.escape(args.package) + r'/\.MainActivity\b', dump))
            if len(identities) == 1: return next(iter(identities))
            # Force-stop/relaunch can briefly retain a destroyed, exiting record.
            # Wait only before establishing a fresh identity; UI checks stay strict.
            assert settle and identity is None, 'Expected one existing target MainActivity: ' + str(sorted(identities))
            time.sleep(min(.2, max(0, deadline - time.monotonic())))

    def foreground(phase, require_target=True):
        nonlocal identity
        deadline = time.monotonic() + 15
        observations = proof.setdefault('foregroundObservations', [])

        def bounded(*command):
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'Capacity foreground recovery exceeded 15 seconds'
            return adb(*command, timeout=remaining)

        def check_identity():
            if identity is not None:
                assert bounded('shell', 'pidof', args.package).strip() == identity['pid'], 'Capacity App process changed without an explicit cold reopen'
                assert activity_identity(timeout=max(.01, deadline - time.monotonic())) == identity['activity'], 'Capacity Activity changed during a UI operation'

        check_identity()
        requested = False
        keyguard_dismissed_at = None
        while time.monotonic() < deadline:
            power = bounded('shell', 'dumpsys', 'power')
            dreams = bounded('shell', 'dumpsys', 'dreams')
            activities = bounded('shell', 'dumpsys', 'activity', 'activities')
            policy = bounded('shell', 'dumpsys', 'window', 'policy')
            top = re.findall(r'topResumedActivity\s*[:=]\s*ActivityRecord\{[^}]*?\su[0-9]+\s+([^\s}]+)', activities)
            if not top: top = re.findall(r'mResumedActivity\s*[:=]\s*ActivityRecord\{[^}]*?\su[0-9]+\s+([^\s}]+)', activities)
            dreaming = bool(re.search(r'mWakefulness=Dreaming|mIsDreaming\s*[=:]\s*true', power + '\n' + dreams) or any('DreamActivity' in component for component in top))
            awake = bool(re.search(r'mWakefulness=Awake', power))
            keyguard = bool(re.search(r'\b(?:showing|isKeyguardShowing|mShowingLockscreen)\s*[=:]\s*true', policy))
            secure = bool(re.search(r'\b(?:secure|mSecure|isSecure)\s*[=:]\s*true', policy))
            own = bool(top) and all(component in (args.package + '/.MainActivity', args.package + '/' + args.package + '.MainActivity') for component in top)
            entry = {'phase': phase, 'hostMonotonic': time.monotonic(), 'dreamActive': dreaming, 'powerAwake': awake, 'topActivities': top, 'keyguardShowing': keyguard, 'keyguardSecure': secure}
            assert len(observations) < 512, 'Foreground observation budget exceeded'
            observations.append(entry)
            prefix = directory / ('foreground-' + str(len(observations)))
            prefix.with_suffix('.power.txt').write_text(power); prefix.with_suffix('.dreams.txt').write_text(dreams); prefix.with_suffix('.activities.txt').write_text(activities); prefix.with_suffix('.policy.txt').write_text(policy)
            if dreaming:
                try:
                    output = bounded('shell', 'cmd', 'dreams', 'stop-dreaming')
                    if re.search(r'SecurityException|Must be ROOT|Permission denied', output, re.IGNORECASE): raise RuntimeError(output[:1024])
                except RuntimeError as error:
                    entry['shellStopDreamError'] = str(error)[:1024]
                    if not re.search(r'SecurityException|Must be ROOT|Permission denied', str(error), re.IGNORECASE): raise
                    # Existing ADB root only, solely for this observed transient
                    # Dream and only after explicit shell permission denial.
                    output = bounded('shell', 'su', '-c', shlex.quote('cmd dreams stop-dreaming'))
                    if re.search(r'SecurityException|Must be ROOT|Permission denied', output, re.IGNORECASE): raise RuntimeError(output[:1024])
                    entry['stopDreamUsedExistingAdbRoot'] = True
                entry['stopDreamRequested'] = True
            if keyguard:
                if keyguard_dismissed_at is None:
                    bounded('shell', 'input', 'keyevent', '224'); bounded('shell', 'wm', 'dismiss-keyguard')
                    keyguard_dismissed_at = time.monotonic(); entry['standardKeyguardDismissRequested'] = True
                elif time.monotonic() - keyguard_dismissed_at >= 1:
                    proof['requiresPhysicalUserUnlock'] = True
                    proof['foregroundBlocked'] = entry
                    (directory / 'foreground.json').write_text(json.dumps(observations, ensure_ascii=False, indent=2))
                    raise AssertionError('Capacity UI requires physical user unlock: keyguard remains showing after standard wake/dismiss; no lock security changes attempted')
                time.sleep(min(.2, max(0, deadline - time.monotonic())))
                continue  # Never launch or tap through a visible keyguard.
            if not dreaming and awake and (own or not require_target):
                if require_target:
                    pid = bounded('shell', 'pidof', args.package).strip()
                    assert pid.isdigit(), 'Target App has no unique live process'
                    if identity is None: identity = {'pid': pid, 'activity': activity_identity(timeout=max(.01, deadline - time.monotonic()), settle=True)}
                    check_identity()
                (directory / 'foreground.json').write_text(json.dumps(observations, ensure_ascii=False, indent=2))
                return
            if dreaming or not awake:
                bounded('shell', 'input', 'keyevent', '224'); bounded('shell', 'wm', 'dismiss-keyguard')
            if require_target and (not requested or not own or dreaming):
                check_identity()
                # No -W: a Dream can make wait-for-draw block despite completed
                # native verification. Top/identity are checked independently.
                bounded('shell', 'am', 'start', '--activity-reorder-to-front', '--activity-single-top', '-n', args.package + '/.MainActivity')
                requested = True
            time.sleep(min(.2, max(0, deadline - time.monotonic())))
        raise AssertionError('Target capacity Activity did not become foreground within 15 seconds')

    def force_stop():
        nonlocal identity
        adb('shell', 'am', 'force-stop', args.package); identity = None

    def launch(action=None, **params):
        foreground('before-deep-link', require_target=identity is not None)
        if action: params.update(action=action, requestId=str(uuid.uuid4()))
        adb('shell', 'am', 'start', '--activity-reorder-to-front', '--activity-single-top', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd:///?' + urlencode(params)), '-n', args.package + '/.MainActivity', timeout=15)
        foreground('after-deep-link')

    def report(event):
        absolute_deadline = time.monotonic() + 360
        deadline = time.monotonic() + 90
        stages = set()
        last_stage = None
        while time.monotonic() < min(deadline, absolute_deadline):
            pid = adb('shell', 'pidof', args.package).strip()
            records = read_reports(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S')) if pid else []
            for item in records:
                if item.get('event') == 'arxd-context-capacity-progress':
                    key = (item.get('phase'), item.get('stage'), item.get('at'))
                    if key not in stages:
                        stages.add(key); last_stage = item
                        proof.setdefault('progress', []).append(item)
                        (directory / 'progress.json').write_text(json.dumps(proof['progress'], ensure_ascii=False, indent=2))
                        deadline = time.monotonic() + 75
                if item.get('event') == 'arxd-context-capacity-failed':
                    proof['failure'] = item
                    raise AssertionError(item)
                if item.get('event') == event:
                    return item
            time.sleep(.4)
        proof['timeoutStage'] = last_stage
        raise AssertionError('Missing native report: ' + event + '; last bounded stage=' + str(last_stage and last_stage.get('stage')))

    def nodes(ensure_foreground=True):
        if ensure_foreground: foreground('before-hierarchy')
        path = '/data/local/tmp/arxd-context-capacity-' + uuid.uuid4().hex + '.xml'
        try:
            (directory / 'latest.xml').unlink(missing_ok=True)
            (directory / 'latest-dump-command.json').unlink(missing_ok=True)
            output = adb('shell', 'uiautomator', 'dump', path, timeout=15, diagnostic='latest-dump-command.json')
            assert re.search(r'UI hier(?:ar)?ch(?:ar)?y dumped to:', output), 'UIAutomator did not produce a fresh hierarchy; see latest-dump-command.json (busy screens may not become idle)'
            value = adb('exec-out', 'cat', path, timeout=5)
            (directory / 'latest.xml').write_text(value)
            items = list(ET.fromstring(value).iter('node'))
            assert items, 'Fresh Android hierarchy contains no nodes'
            if ensure_foreground: assert any(item.get('package') == args.package for item in items), 'Fresh hierarchy has no owned App nodes'
            return items
        except Exception as failure:
            if 'hierarchyFailure' not in proof:
                diagnostic = directory / 'latest-dump-command.json'
                proof['hierarchyFailure'] = {'error': str(failure), 'dump': json.loads(diagnostic.read_text()) if diagnostic.exists() else None}
                try: (directory / 'hierarchy-failure.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True, timeout=5))
                except Exception as error: proof['hierarchyFailureCaptureError'] = str(error)
            raise
        finally:
            try: adb('shell', 'rm', '-f', path, timeout=5)
            except Exception as error: proof.setdefault('hierarchyCleanupErrors', []).append(str(error))

    def node(name):
        for item in nodes():
            if item.get('package') == args.package and (name in (item.get('text'), item.get('content-desc'), item.get('resource-id')) or item.get('resource-id', '').endswith('/' + name)):
                return item
        raise AssertionError('Missing UI control: ' + name)

    def tap(*names):
        for name in names:
            try:
                item = node(name)
            except AssertionError:
                continue
            bounds = list(map(int, re.findall(r'\d+', item.get('bounds'))))
            x1, y1, x2, y2 = bounds
            if x2 <= x1 or y2 <= y1:
                continue
            adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); time.sleep(.25); return
        raise AssertionError('Missing UI control: ' + str(names))

    def capture(name, ensure_foreground=True):
        if ensure_foreground: foreground('before-capture-' + name)
        (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True, timeout=15))
        nodes(ensure_foreground=ensure_foreground)
        (directory / (name + '.xml')).write_text((directory / 'latest.xml').read_text())

    def ui_report(phase, after=0):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', args.package).strip()
            records = read_reports(adb('logcat', '-d', '--pid=' + pid, '-v', 'raw', '-s', 'ArxdVerify:I', '*:S')) if pid else []
            found = [item for item in records if item.get('event') == 'arxd-context-capacity-ui' and item.get('phase') == phase and item.get('sequence', 0) > after]
            if found:
                latest = max(found, key=lambda item: item['sequence'])
                proof.setdefault('uiStates', []).append(latest)
                return latest
            time.sleep(.1)
        raise AssertionError('Missing actual capacity UI state: ' + phase)

    def inspect_ui():
        after = max((item.get('sequence', 0) for item in proof.get('uiStates', [])), default=0)
        launch('ui-context-capacity-inspect')
        return ui_report('inspected', after)

    def bounds(item):
        return list(map(int, re.findall(r'\d+', item.get('bounds'))))

    def display_geometry():
        size = list(re.finditer(r'(?:Physical|Override) size: (\d+)x(\d+)', adb('shell', 'wm', 'size')))[-1]
        densities = re.findall(r'(?:Physical|Override) density: (\d+)', adb('shell', 'wm', 'density'))
        width, height = map(int, size.groups()); pixels_per_dp = int(densities[-1]) / 160
        return width, height, pixels_per_dp

    def scroll_to(name):
        for _ in range(5):
            try:
                item = node(name)
                if bounds(item)[3] > bounds(item)[1]: return item
            except AssertionError:
                pass
            width, height, _ = display_geometry()
            adb('shell', 'input', 'swipe', str(width // 2), str(int(height * .83)), str(width // 2), str(int(height * .35)), '250')
        raise AssertionError('Control remains outside bounded detail scroll: ' + name)

    def same_inspection(before, after):
        for key in ['active', 'entries', 'rawEntries', 'rawEntryIds', 'head', 'turns', 'tools', 'requests', 'selectedSkills']:
            assert before.get(key) == after.get(key), 'Capacity details/theme changed committed ' + key
        for key in ['tokens', 'limit', 'revision', 'configurationRevision']:
            assert before['capacity'][key] == after['capacity'][key], 'Read-only UI changed capacity ' + key

    def ime_shown():
        value = adb('shell', 'dumpsys', 'input_method')
        (directory / 'latest-ime.txt').write_text(value)
        return bool(re.search(r'(?:mInputShown|isInputViewShown)\s*[=:]\s*true', value))

    def visual(name, prepared):
        marker = 'CAPACITY_DRAFT_' + name + '\nCAPACITY_SECOND_LINE'
        # Expo's native extractor decodes twice before URL reparsing, which
        # strips a raw LF. Keep it encoded until local route-param consumption.
        launch(prompt=quote(quote(marker, safe=''), safe=''), composeId=str(uuid.uuid4())); time.sleep(.2)
        if not any(item.get('resource-id', '').endswith('remove-attachment') for item in nodes()):
            launch(prompt='', composeId=str(uuid.uuid4()), attachmentId=prepared['fixture']['file'])
        time.sleep(.2)
        expected_draft = node('message-input').get('text')
        assert marker in expected_draft and '\n' in expected_draft, 'Native TextInput did not contain the exact multiline capacity draft'
        tap('message-input')
        assert ime_shown(), 'Keyboard-visible case has no observed visible IME'
        meter = node('context-capacity')
        x1, y1, x2, y2 = bounds(meter)
        width, height, scale = display_geometry()
        assert 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height, 'Capacity indicator clips the native viewport'
        assert (x2 - x1) / scale >= 44 - 1 and (y2 - y1) / scale >= 44 - 1, 'Capacity touch target is smaller than 44dp'
        send = node('send-message'); send_bounds = bounds(send)
        assert y1 >= send_bounds[3], 'Capacity indicator overlaps Send/input controls'
        assert node('remove-attachment').get('enabled') == 'true', 'Pending attachment control is inaccessible'
        skill = prepared['fixture']['name']
        assert any(skill in item.get('content-desc', '') for item in nodes()), 'Selected skill chip disappeared'
        footer = [item for item in nodes() if item.get('text', '').startswith('Capacity reference model') and bounds(item)[1] < y2 and bounds(item)[3] > y1]
        assert footer and all(0 <= bounds(item)[0] < bounds(item)[2] <= x1 for item in footer), 'Long model label overlaps or displaces the reserved capacity value'
        assert '上下文容量' in meter.get('content-desc', '') or 'Context capacity' in meter.get('content-desc', '')
        before = inspect_ui(); same_inspection(prepared, before)
        capture(name + '-keyboard')
        tap('context-capacity'); capture(name + '-details')
        assert any('token' in item.get('text', '') for item in nodes() if item.get('package') == args.package)
        assert not any(re.search(r'NaN|Infinity|≈-\d', item.get('text', '')) for item in nodes())
        close = bounds(node('context-close')); assert (close[2] - close[0]) / scale >= 43 and (close[3] - close[1]) / scale >= 43
        tap('context-close')
        assert node('message-input').get('text') == expected_draft, 'Details modified the multiline draft'
        assert node('remove-attachment').get('enabled') == 'true'
        assert any(skill in item.get('content-desc', '') for item in nodes())
        after = inspect_ui(); same_inspection(before, after)
        # Back closes only the IME; keep the same Activity and composer state.
        if ime_shown(): adb('shell', 'input', 'keyevent', '4')
        time.sleep(.2); assert not ime_shown(), 'Keyboard did not close'; capture(name + '-keyboard-closed')
        assert node('message-input').get('text') == expected_draft
        proof.setdefault('layoutMeasurements', []).append({'name': name, 'widthPx': width, 'heightPx': height, 'pixelsPerDp': scale, 'widthDp': width / scale, 'meterBounds': [x1, y1, x2, y2], 'touchWidthDp': (x2-x1)/scale, 'touchHeightDp': (y2-y1)/scale, 'draftLines': len(expected_draft.splitlines())})
        proof['uiChecks'].append(name + ': native 44dp target, viewport/Send/long-label bounds, multiline draft, attachment and selected skill preservation, numeric/accessibility labels, no request/tool/entry/head/token change')

    def busy_controls():
        launch('ui-context-capacity-generation'); held = ui_report('generation-held')
        assert held['busy']
        meter = bounds(node('context-capacity')); stop = bounds(node('stop-analysis'))
        assert meter[1] >= stop[3], 'Capacity overlaps the actual Stop control'
        tap('context-capacity'); scroll_to('context-compact')
        assert node('context-compact').get('enabled') == 'false', 'Details permits manual compaction during active generation'
        unchanged = inspect_ui(); same_inspection(held, unchanged)
        capture('busy-stop-and-disabled-manual'); tap('context-close')
        launch('ui-context-capacity-generation-release'); released = ui_report('generation-released')
        assert not released['busy']
        proof['uiChecks'].append('Actual held generation retains Stop access, disables manual details action, and details inspection does not dispatch another request')

    def manual_controls():
        launch('ui-context-capacity-manual-hold'); held = ui_report('manual-hold')
        tap('context-capacity'); scroll_to('context-compact'); tap('context-compact')
        running = inspect_ui()
        assert running['compactions'] == 1 and running['summaries'] == 1 and running['capacity']['head'] == held['capacity']['head'] and running['capacity']['tokens'] == held['capacity']['tokens'], 'Detail action did not use one real pending Pi compaction'
        # Its next deliberate tap is the existing cancellation action; it must
        # never admit another summary task while the first is live.
        tap('context-compact')
        deadline = time.monotonic() + 10
        canceled = inspect_ui()
        while canceled['compactions'] and time.monotonic() < deadline:
            time.sleep(.1); canceled = inspect_ui()
        assert not canceled['compactions'] and canceled['summaries'] == 1 and canceled['capacity']['head'] == held['capacity']['head'] and canceled['capacity']['tokens'] == held['capacity']['tokens'], 'Stop in details duplicated compaction or fabricated a committed decrease'
        capture('manual-detail-cancel'); tap('context-close')
        launch('ui-context-capacity-release'); ui_report('released')
        launch('ui-context-capacity-manual-error'); ui_report('manual-error')
        tap('context-capacity'); scroll_to('context-compact'); tap('context-compact')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            values = nodes()
            if any('Offline capacity compaction failure' in item.get('text', '') for item in values): break
            time.sleep(.1)
        else: raise AssertionError('Detail compaction failure is not visibly retained')
        capture('manual-detail-error'); tap('context-close')
        launch('ui-context-capacity-manual-normal'); normal = ui_report('manual-normal')
        tap('context-capacity'); scroll_to('context-compact'); tap('context-compact')
        deadline = time.monotonic() + 15; completed = inspect_ui()
        while (completed['compactions'] or completed['capacity']['head'] == normal['capacity']['head']) and time.monotonic() < deadline:
            time.sleep(.1); completed = inspect_ui()
        assert completed['capacity']['head'] != normal['capacity']['head'] and completed['capacity']['tokens'] < normal['capacity']['tokens'], 'Detail manual action failed to commit a real summary and decrease effective context'
        assert normal['rawEntries'] > 0 and len(normal['rawEntryIds']) == normal['rawEntries'] and len(completed['rawEntryIds']) == completed['rawEntries'] and completed['rawEntries'] >= normal['rawEntries'] and set(normal['rawEntryIds']).issubset(completed['rawEntryIds']), 'Detail manual compaction did not retain every original raw history entry'
        capture('manual-detail-success'); tap('context-close')
        launch('ui-new'); tap('context-capacity'); scroll_to('context-compact')
        assert node('context-compact').get('enabled') == 'false', 'Uncreated conversation exposes a live manual compaction action'
        capture('manual-detail-disabled'); tap('context-close')
        proof['uiChecks'].append('Actual details action: one Pi task, next tap cancels without duplicate/decrease, visible failure, successful committed head with raw history retained, unavailable action disabled')

    density = adb('shell', 'wm', 'density')
    old_override = re.search(r'Override density: (\d+)', density)
    old_scale = adb('shell', 'settings', 'get', 'system', 'font_scale').strip()
    ui_prepared = False
    try:
        installed = adb('shell', 'pm', 'path', args.package).splitlines()
        assert len(installed) == 1 and installed[0].startswith('package:'), 'Expected one installed acceptance APK'
        installed_hash = adb('shell', 'sha256sum', shlex.quote(installed[0].removeprefix('package:'))).split()[0]
        assert installed_hash == proof['apkSha256'], 'Supplied APK differs from the installed acceptance package'
        proof['installedApkSha256'] = installed_hash
        proof['device'] = {key: adb('shell', 'getprop', prop).strip() for key, prop in [('model', 'ro.product.model'), ('os', 'ro.build.version.release'), ('sdk', 'ro.build.version.sdk'), ('abi', 'ro.product.cpu.abi')]}
        if args.resume_ui:
            previous = json.loads(args.resume_ui.read_text())
            assert previous.get('package') == args.package and previous.get('serial') == args.serial and previous.get('apkSha256') == installed_hash and previous.get('installedApkSha256') == installed_hash and previous.get('device') == proof['device'], 'Reused native proof differs from the actual installed APK/device/OS'
            assert previous.get('native', {}).get('verified') is True and previous.get('reopen', {}).get('verified') is True, 'Native and cold-reopen acceptance must already have passed'
            proof.update(native=previous['native'], reopen=previous['reopen'], reusedNativeEvidence=str(args.resume_ui.resolve()))
            if args.manual_controls_only:
                visual_names = ['fire', 'spring', 'spring-reduced-motion']
                visual_suffix = ': native 44dp target, viewport/Send/long-label bounds, multiline draft, attachment and selected skill preservation, numeric/accessibility labels, no request/tool/entry/head/token change'
                assert previous.get('uiChecks') == [name + visual_suffix for name in visual_names], 'Manual-only reuse requires exactly the three completed visual checks'
                assert len(previous['native'].get('checks', [])) >= 118, 'Manual-only reuse requires the completed native capacity acceptance'
                measurements = {item['name']: item for item in previous.get('layoutMeasurements', [])}
                assert all(name in measurements and measurements[name].get('draftLines', 0) >= 2 and measurements[name].get('touchWidthDp', 0) >= 43 and measurements[name].get('touchHeightDp', 0) >= 43 for name in visual_names), 'Reused visuals must prove real multiline drafts and native touch bounds'
                assert previous.get('uiCleanup', {}).get('phase') == 'cleaned' and not previous['uiCleanup']['busy'] and not previous['uiCleanup']['compactions'], 'Reused partial run must have completed its owned UI cleanup'
                proof.update(reusedVisualEvidence=str(args.resume_ui.resolve()), reusedUiChecks=previous['uiChecks'], reusedLayoutMeasurements=previous['layoutMeasurements'])
        elif not args.manual_controls_only:
            force_stop()
            launch('ui-context-capacity'); proof['native'] = report('arxd-context-capacity'); assert proof['native']['verified']
            force_stop()
            launch('ui-context-capacity-reopen'); proof['reopen'] = report('arxd-context-capacity-reopen'); assert proof['reopen']['verified']
        if not args.manual_controls_only:
            launch('ui-context-capacity-layout'); ui_prepared = True; prepared = ui_report('prepared')
            launch('ui-fire'); time.sleep(.3); visual('fire', prepared)
            launch('ui-spring'); time.sleep(.3); visual('spring', prepared)
            if args.layout_matrix:
                foreground('before-layout-configuration')
                previous_identity = dict(identity)
                width, _, _ = display_geometry()
                adb('shell', 'wm', 'density', str(math.ceil(width * 160 / 340)))
                adb('shell', 'settings', 'put', 'system', 'font_scale', '1.35')
                time.sleep(1)
                assert adb('shell', 'pidof', args.package).strip() == previous_identity['pid'], 'Capacity App process changed during layout configuration'
                # These deliberate Android configuration changes may recreate the
                # Activity, but must never admit a crash/restarted App process.
                identity = None
                foreground('after-layout-configuration')
                assert identity['pid'] == previous_identity['pid'], 'Capacity App restarted while settling layout configuration'
                proof.setdefault('configurationIdentityTransitions', []).append({'phase': 'narrow-large-text', 'before': previous_identity, 'after': dict(identity)})
                assert float(adb('shell', 'settings', 'get', 'system', 'font_scale').strip()) == 1.35, 'Requested native enlarged font scale was not applied'
                assert 320 <= display_geometry()[0] / display_geometry()[2] <= 341, 'Requested native narrow width was not applied'
                launch('ui-fire'); visual('fire-narrow-large-text', prepared)
                launch('ui-spring'); visual('spring-narrow-large-text', prepared)
            launch('ui-context-capacity-reduced-motion'); visual('spring-reduced-motion', prepared)
            busy_controls()
        ui_prepared = True
        manual_controls()
        proof['verificationScope'] = ('automated-manual-controls-only; ' + ('native/reopen and three visuals reused from matching proof' if args.resume_ui else 'native/reopen/visuals not executed') + '; busy-generation UI remains separate manual evidence') if args.manual_controls_only else 'automated-native-functional-and-ui-structure; TalkBack and screenshot review remain separate'
        proof['pendingManualAcceptance'] = ['TalkBack spoken labels/value/state and focus traversal require actual assistive-technology observation', 'Native screenshots must be visually inspected before visual acceptance is claimed']
        if args.manual_controls_only: proof['pendingManualAcceptance'].append('Busy generation Stop/details interaction is separate manual evidence; this selector does not verify it')
        proof['verified'] = True
    finally:
        if ui_prepared:
            try:
                launch('ui-context-capacity-cleanup'); proof['uiCleanup'] = ui_report('cleaned')
            except Exception as error:
                proof['verified'] = False; proof['uiCleanupError'] = str(error)
        if args.layout_matrix:
            adb('shell', 'wm', 'density', old_override.group(1) if old_override else 'reset')
            if old_scale in ('null', ''):
                adb('shell', 'settings', 'delete', 'system', 'font_scale')
            else:
                adb('shell', 'settings', 'put', 'system', 'font_scale', old_scale)
        try:
            capture('final', ensure_foreground=False)
        except Exception as error:
            proof['captureError'] = str(error)
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'verified': proof['verified'], 'scope': scope, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
