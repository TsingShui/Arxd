#!/usr/bin/env python3
"""Drive real process/MCP pages and the owned Android foreground notification.

Requires an installed, non-debuggable isolated Arxd APK. Does not install APKs,
clear data or call process/MCP mutations in place of UI controls.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import urlopen
import uuid
import xml.etree.ElementTree as ET
from android_reports import read_reports

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--lifecycle', action='store_true', help='Also replace Activity, kill only validated host PID, user-stop FGS and force-stop distinct active fixtures; requires existing root and Android 13+')
    parser.add_argument('--lifecycle-only', action='store_true', help='Only run existing Activity/host/user-stop/force-stop lifecycle checks; implies --lifecycle and skips forms/notifications')
    args = parser.parse_args()
    args.lifecycle = args.lifecycle or args.lifecycle_only
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Use an explicit isolated test package; production Arxd is forbidden')
    run = uuid.uuid4().hex[:16]
    directory = ROOT / 'target/arxd/services-ui-evidence' / run
    directory.mkdir(parents=True)
    scope = 'lifecycle-only' if args.lifecycle_only else 'forms-notification-and-optional-lifecycle'
    proof = {'verified': False, 'scope': scope, 'run': run, 'package': args.package, 'serial': args.serial,
             'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'checks': [], 'lifecycleRequested': args.lifecycle,
             'mode': 'actual-production-page-controls/native-process-mcp/isolated-android'}
    setup = False
    forwards = []
    notification_shade_opened = False

    def adb(*command, binary=False, timeout=90):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=not binary, timeout=timeout)
        if result.returncode:
            raise RuntimeError(str(result.stderr))
        return result.stdout

    def launch(route, **params):
        url = 'arxd://' + route + ('?' + urlencode(params) if params else '')
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(url), '-n', args.package + '/.MainActivity')
        time.sleep(.25)

    def observe(stage='observe', timeout=150):
        nonce = uuid.uuid4().hex[:16]
        launch('verify-services-ui', run=run, stage=stage, package=args.package, nonce=nonce)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pids = adb('shell', 'pidof', args.package, timeout=remaining(deadline)).split()
            # A fork may briefly inherit the App name. Defer this observation
            # within the same deadline, never choose a PID by ordering.
            if len(pids) == 1 and re.fullmatch(r'[0-9]+', pids[0]) and int(pids[0]) > 1:
                text = adb('logcat', '-d', '--pid=' + pids[0], '-v', 'raw', '-s', 'ArxdVerify:I', '*:S', timeout=remaining(deadline))
                for report in reversed(read_reports(text)):
                    if report.get('event') == 'arxd-services-ui-stage' and report.get('run') == run and report.get('nonce') == nonce:
                        assert report.get('verified'), report
                        return report
            time.sleep(.2)
        raise AssertionError('Missing actual Android UI observation: ' + stage)

    def remaining(deadline):
        value = deadline - time.monotonic()
        assert value > 0, 'Owned UI readiness/search budget expired'
        return value

    def hierarchy(timeout=15):
        deadline = time.monotonic() + timeout
        destination = '/data/local/tmp/arxd-services-ui-' + run + '.xml'
        for _ in range(5):
            adb('shell', 'rm', '-f', destination, timeout=remaining(deadline))
            output = adb('shell', 'uiautomator', 'dump', destination, timeout=remaining(deadline))
            if 'dumped to:' in output:
                text = adb('exec-out', 'cat', destination, timeout=remaining(deadline))
                (directory / 'latest.xml').write_text(text)
                return ET.fromstring(text)
            time.sleep(min(.3, remaining(deadline)))
        raise AssertionError('No fresh Android UI hierarchy')

    def bounds(node):
        values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
        assert len(values) == 4
        return values

    def app_nodes(timeout=15):
        nodes = list(hierarchy(timeout).iter('node'))
        assert any(node.get('package') == args.package for node in nodes), 'Target application is not visible'
        return [node for node in nodes if node.get('package') == args.package]

    def swipe(up=True, owned=None, timeout=15):
        deadline = time.monotonic() + timeout
        nodes = [node for node in (app_nodes(remaining(deadline)) if owned is None else owned) if node.get('package') == args.package and node.get('scrollable') == 'true' and node.get('enabled') != 'false']
        assert nodes, 'No owned scrollable viewport; refusing an unscoped swipe'
        viewport = max(nodes, key=lambda node: (bounds(node)[2]-bounds(node)[0])*(bounds(node)[3]-bounds(node)[1]))
        x1, y1, x2, y2 = bounds(viewport)
        assert x1 >= 0 and y1 >= 0 and x2 > x1 and y2 > y1
        adb('shell', 'input', 'swipe', str((x1+x2)//2), str(int(y1+(y2-y1)*(.78 if up else .3))), str((x1+x2)//2), str(int(y1+(y2-y1)*(.3 if up else .78))), '250', timeout=remaining(deadline))
        time.sleep(min(.2, remaining(deadline)))

    def find_control(nodes, labels, edit=False):
        candidates = []
        for node in nodes:
            if node.get('package') != args.package or node.get('enabled') == 'false' or edit and node.get('class') != 'android.widget.EditText':
                continue
            if any(label in (node.get('text'), node.get('content-desc'), node.get('resource-id')) or node.get('resource-id', '').endswith('/' + label) for label in labels):
                x1, y1, x2, y2 = bounds(node)
                if x1 >= 0 and y1 >= 0 and x2 > x1 and y2 > y1:
                    candidates.append(((x2-x1)*(y2-y1), node, (str((x1+x2)//2), str((y1+y2)//2))))
        if candidates:
            _, node, point = min(candidates, key=lambda value: value[0])
            return node, point
        return None

    def control(labels, scroll=True, edit=False):
        deadline = time.monotonic() + (45 if scroll else 15)
        up, steps, previous = False, 0, None
        for _ in range(17 if scroll else 64):
            owned = app_nodes(remaining(deadline))
            found = find_control(owned, labels, edit)
            if found: return found
            if not scroll:
                time.sleep(min(.2, remaining(deadline)))
                continue
            signature = tuple((node.get('resource-id'), node.get('text'), node.get('content-desc'), node.get('bounds'), node.get('enabled')) for node in owned)
            if signature == previous or steps == 8:
                if up: break
                up, steps = True, 0
            previous = signature
            swipe(up=up, owned=owned, timeout=remaining(deadline)); steps += 1
        raise AssertionError('Missing owned UI control: ' + repr(labels))

    def tap(*labels, scroll=True):
        node, point = control(labels, scroll)
        assert node.get('package') == args.package
        adb('shell', 'input', 'tap', *point)
        time.sleep(.3)

    def field(label, value):
        node, point = control(('service-field-' + label,), edit=True)
        assert node.get('package') == args.package and value.isascii()
        old = node.get('text', '')
        assert len(old) <= 4096, 'Do not clear an uncontrolled input'
        adb('shell', 'input', 'tap', *point)
        adb('shell', 'input', 'keyevent', '123')
        if old:
            adb('shell', 'input', 'keyevent', *(['67'] * len(old)))
        adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))
        ime = adb('shell', 'dumpsys', 'input_method')
        if re.search(r'(?:mInputShown|isInputViewShown)=true', ime):
            app_nodes(); adb('shell', 'input', 'keyevent', '4')
        time.sleep(.2)

    def json_field(value):
        node, point = control(('mcp-edit-json',), edit=True)
        assert node.get('package') == args.package and value.isascii()
        adb('shell', 'input', 'tap', *point)
        adb('shell', 'input', 'keycombination', '113', '29')
        parts = value.split('"')
        for index, part in enumerate(parts):
            if part:
                adb('shell', 'input', 'text', shlex.quote(part.replace(' ', '%s')))
            if index < len(parts) - 1:
                adb('shell', 'input', 'keycombination', '59', '75')
        ime = adb('shell', 'dumpsys', 'input_method')
        if re.search(r'(?:mInputShown|isInputViewShown)=true', ime):
            app_nodes(); adb('shell', 'input', 'keyevent', '4')
        time.sleep(.2)

    def list_page(route, new_control):
        launch(route)
        deadline = time.monotonic() + 15
        backed = False
        detail_ids = ('process-stop', 'process-repeat', 'process-log', 'process-submit') if route == 'processes' else ('mcp-toggle', 'mcp-process')
        for _ in range(64):
            owned = [node for node in hierarchy(remaining(deadline)).iter('node') if node.get('package') == args.package]
            if find_control(owned, (new_control,)): return
            # A loading root page also has Back. Only leave an observed service
            # detail/form, never infer that state from a missing loading button.
            detail = any(any(node.get('resource-id', '').endswith(value) for value in detail_ids) for node in owned)
            backs = [found for node in owned if node.get('clickable') == 'true' and (found := find_control([node], ('返回', 'Back')))]
            if detail and backs and not backed:
                assert len(backs) == 1, 'Expected one owned header Back button'
                node, point = backs[0]
                adb('shell', 'input', 'tap', *point, timeout=remaining(deadline))
                backed = True
            time.sleep(min(.2, remaining(deadline)))
        raise AssertionError('Service list did not become ready: ' + route)

    def shot(name, owned=True):
        errors = []
        try:
            tree = hierarchy()
            (directory / (name + '.xml')).write_text(ET.tostring(tree, encoding='unicode'))
            if owned: assert any(node.get('package') == args.package for node in tree.iter('node')), 'Target application is not visible'
        except Exception as error: errors.append(str(error))
        try: (directory / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True, timeout=15))
        except Exception as error: errors.append(str(error))
        if errors: raise AssertionError('UI capture failed: ' + '; '.join(errors))

    def restore_http_policy():
        expected = proof['httpPolicyBefore']['allowPlaintextHttp']
        assert type(expected) is bool, 'Original HTTP policy was not an authoritative boolean'
        current = observe(timeout=30)['httpPolicy']
        changed = current['allowPlaintextHttp'] != expected
        if changed:
            launch('settings')
            switch, _ = control(('mcp-http-policy',))
            assert switch.get('checked') == str(current['allowPlaintextHttp']).lower(), 'The settings HTTP toggle differs from the observed policy; refusing a guessed toggle'
            tap('mcp-http-policy')
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = observe(timeout=remaining(deadline))['httpPolicy']
                if current['allowPlaintextHttp'] == expected: break
                time.sleep(min(.2, remaining(deadline)))
            else: raise AssertionError('The settings HTTP toggle did not restore the original HTTP policy')
        assert current['allowPlaintextHttp'] == expected, 'Original HTTP policy remains changed'
        proof['httpPolicyRestoration'] = {'verified': True, 'expected': expected, 'actual': current, 'switchTapped': changed, 'method': 'production-settings-toggle-and-native-observation'}

    def process(snapshot, suffix):
        return next((item for item in snapshot['processes'] if item['name'] == 'ui-' + run + '-' + suffix), None)

    def wait_process(suffix, state):
        for _ in range(30):
            result = observe()
            row = process(result, suffix)
            if row and row['state'] == state:
                return result, row
            assert not row or row['state'] not in ('failed', 'lost'), row
            time.sleep(.15)
        raise AssertionError('Process did not reach ' + state)

    def wait_mcp(server_id, predicate):
        for _ in range(30):
            snapshot = observe()
            row = next((item for item in snapshot['mcps'] if item['id'] == server_id), None)
            if row and predicate(row):
                return snapshot, row
            time.sleep(.15)
        raise AssertionError('MCP UI operation did not settle')

    def notification_row():
        # SystemUI does not expose target package on each row. Prove there is one
        # managed-channel record, owned by this isolated APK, before using its row.
        dump = adb('shell', 'dumpsys', 'notification', '--noredact')
        records = [block for block in re.split(r'(?=NotificationRecord\()', dump) if block.startswith('NotificationRecord(') and 'channel=arxd-managed-processes' in block]
        assert len(records) == 1 and re.search(r'pkg=' + re.escape(args.package) + r'\b', records[0]), 'Ambiguous or foreign managed notification; no SystemUI tap'
        tree = hierarchy()
        titles = [node for node in tree.iter('node') if node.get('package') == 'com.android.systemui' and node.get('text') == 'Arxd · 后台进程']
        assert len(titles) == 1, 'No unique owned service notification title'
        parents = {child: parent for parent in tree.iter() for child in parent}
        row = titles[0]
        while row in parents and not row.get('resource-id', '').endswith('/expandableNotificationRow'):
            row = parents[row]
        assert row.get('package') == 'com.android.systemui', 'Cannot isolate notification subtree'
        return row, titles[0]

    def notification_tap(stop=False):
        nonlocal notification_shade_opened
        adb('shell', 'cmd', 'statusbar', 'expand-notifications'); notification_shade_opened = True; time.sleep(.4)
        row, title = notification_row()
        if stop:
            actions = [node for node in row.iter('node') if node.get('text') == '停止全部' and node.get('package') == 'com.android.systemui']
            if not actions:
                expand = next((node for node in row.iter('node') if node.get('resource-id', '').endswith('/expand_button') and node.get('package') == 'com.android.systemui'), None)
                assert expand is not None, 'Owned notification action is unavailable'
                x1, y1, x2, y2 = bounds(expand); adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); time.sleep(.3)
                row, _ = notification_row()
                actions = [node for node in row.iter('node') if node.get('text') == '停止全部' and node.get('package') == 'com.android.systemui']
            assert len(actions) == 1, 'No unique Stop All action in the owned notification'
            target = actions[0]
        else:
            target = title
        x1, y1, x2, y2 = bounds(target)
        assert x2 > x1 and y2 > y1
        adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); time.sleep(.4)
        if stop:
            adb('shell', 'cmd', 'statusbar', 'collapse'); notification_shade_opened = False
        else:
            control(('process-new',), scroll=False); notification_shade_opened = False

    def lifecycle_checks(fixture, start_process):
        if int(proof['device']['sdk']) < 33:
            raise AssertionError('Full lifecycle acceptance requires Android 13+ Task Manager stop support')
        help_text = adb('shell', 'cmd', 'activity', 'help')
        assert 'stop-app' in help_text, 'Device activity shell lacks documented Task Manager stop command'
        user = adb('shell', 'am', 'get-current-user').strip()
        assert user.isdigit()
        packages = adb('shell', 'pm', 'list', 'packages', '-U', '--user', user, args.package)
        match = re.findall(r'^package:' + re.escape(args.package) + r' uid:(\d+)$', packages, re.M)
        assert len(match) == 1 and int(match[0]) >= 10000, 'Cannot prove isolated package UID'
        package_uid = int(match[0])
        direct_root = adb('shell', 'id', '-u').strip() == '0'
        if not direct_root:
            assert adb('shell', 'su', '-c', shlex.quote('id -u')).strip() == '0', 'Existing root is required; no rooting/fallback force-stop is attempted'

        def root_shell(script):
            return adb('shell', 'sh', '-c', shlex.quote(script)) if direct_root else adb('shell', 'su', '-c', shlex.quote(script))

        def identity(pid, expected_uid, cmdline=None):
            assert isinstance(pid, int) and pid > 1
            stat = root_shell('cat /proc/' + str(pid) + '/stat').strip()
            fields = stat.rsplit(') ', 1)[1].split()
            uid = re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', root_shell('cat /proc/' + str(pid) + '/status'), re.M)
            assert uid and all(int(value) == expected_uid for value in uid.groups())
            assert stat.split(' ', 1)[0] == str(pid) and fields[19].isdigit()
            command = root_shell('cat /proc/' + str(pid) + '/cmdline').split('\0', 1)[0]
            if cmdline is not None: assert command == cmdline
            return {'pid': pid, 'uid': expected_uid, 'startTicks': fields[19], 'state': fields[0], 'command': command}

        def host(snapshot):
            native = snapshot['host']
            pids = adb('shell', 'pidof', args.package).split()
            assert pids == [str(native['pid'])] and native['uid'] == package_uid
            return identity(int(native['pid']), package_uid, args.package)

        def activity_record():
            text = adb('shell', 'dumpsys', 'activity', 'activities')
            own = [line.strip() for line in text.splitlines() if args.package + '/.MainActivity' in line]
            resumed = [line for line in own if 'topResumedActivity' in line or 'mResumedActivity' in line]
            values = set(re.findall(r'ActivityRecord\{([a-f0-9]+)\s+u\d+\s+' + re.escape(args.package) + r'/\.MainActivity\b', '\n'.join(resumed or own)))
            assert len(values) == 1, 'Cannot identify a unique target ActivityRecord'
            return {'identity': next(iter(values)), 'records': own}

        def stopped_flag():
            text = adb('shell', 'dumpsys', 'package', args.package)
            row = next((line.strip() for line in text.splitlines() if re.search(r'\bUser ' + user + r':', line)), '')
            value = re.search(r'\bstopped=(true|false)', row)
            assert value, 'Cannot read target package stopped state'
            return {'stopped': value[1] == 'true', 'record': row}

        def wait_host_gone(before):
            for _ in range(60):
                pids = adb('shell', 'pidof', args.package).split()
                if not pids: return
                assert pids == [str(before['pid'])], 'Unexpected replacement host before explicit cold reopen'
                time.sleep(.1)
            raise AssertionError('Target host did not exit')

        def kill_exact_host(before):
            # Recheck all captured identities in the same privileged shell just
            # before signaling this one PID. Never signal a process group here.
            pid, uid, ticks = before['pid'], before['uid'], before['startTicks']
            assert str(ticks).isdigit() and uid == package_uid
            script = (
                'set -eu\n'
                f'line=$(cat /proc/{pid}/stat)\nrest=${{line##*) }}\nset -- $rest\n'
                f'[ "${{20}}" = {shlex.quote(ticks)} ] || exit 43\n'
                f'line=$(grep "^Uid:" /proc/{pid}/status)\nset -- $line\n'
                f'[ "$2" = {uid} ] && [ "$3" = {uid} ] && [ "$4" = {uid} ] && [ "$5" = {uid} ] || exit 44\n'
                f'command=$(tr "\\000" "\\n" < /proc/{pid}/cmdline | head -n 1)\n'
                f'[ "$command" = {shlex.quote(args.package)} ] || exit 45\n'
                f'kill -KILL {pid}\n')
            root_shell(script)

        def child_observation(before):
            stat = root_shell(f'if test -r /proc/{before["pid"]}/stat; then cat /proc/{before["pid"]}/stat 2>/dev/null || true; fi').strip()
            if not stat: return {'state': 'proven-absent'}
            fields = stat.rsplit(') ', 1)[1].split()
            current = {'pid': before['pid'], 'startTicks': fields[19], 'state': fields[0]}
            if current['startTicks'] != before['startTicks']: return {'state': 'original-identity-gone', 'observed': current}
            return {'state': 'original-zombie' if current['state'] in ('Z', 'X') else 'original-still-alive', 'observed': current}

        evidence = {'userStopSource': 'https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping', 'packageUid': package_uid, 'cases': []}
        proof['lifecycle'] = evidence
        for suffix, operation in [('life_activity', 'activity-replacement'), ('life_host', 'host-sigkill'), ('life_userstop', 'android-task-manager-stop'), ('life_force', 'force-stop')]:
            snapshot, record = start_process(suffix, ['python', fixture['processFixture'], 'http', fixture['directory'] + '/' + suffix])
            for _ in range(30):
                snapshot = observe(); port = snapshot['counters'][suffix + '/port']
                if port and snapshot['counters'][suffix + '/launches'] == '1': break
                time.sleep(.1)
            assert port.isdigit() and not snapshot['foreignActive']
            host_before = host(snapshot)
            supervisor = identity(int(record['pid']), package_uid)
            payload = identity(int(record['payloadPid']), package_uid)
            assert supervisor['startTicks'] == str(record['startTicks'])
            host_port = int(adb('forward', 'tcp:0', 'tcp:' + port).strip()); forwards.append(host_port)
            def health():
                with urlopen(f'http://127.0.0.1:{host_port}/health', timeout=3) as response: value = json.load(response)
                assert value['fixture'] == 'arxd-managed-http-v1' and value['pid'] == payload['pid']
                return value
            item = {'operation': operation, 'instance': record['id'], 'hostBefore': host_before, 'supervisorBefore': supervisor, 'payloadBefore': payload, 'before': snapshot, 'healthBefore': health()}
            evidence['cases'].append(item)
            if operation == 'activity-replacement':
                before_activity = activity_record()
                adb('shell', 'am', 'start', '-W', '--activity-new-task', '--activity-clear-task', '-a', 'android.intent.action.VIEW', '-d', 'arxd://processes', '-n', args.package + '/.MainActivity')
                control(('process-new',), scroll=False)
                after_activity = activity_record(); after = observe()
                item.update(activityBefore=before_activity, activityAfter=after_activity, hostAfter=host(after), healthAfter=health())
                same = process(after, suffix)
                assert before_activity['identity'] != after_activity['identity'] and all(item['hostAfter'][key] == host_before[key] for key in ['pid', 'uid', 'startTicks', 'command'])
                assert same['id'] == record['id'] and same['pid'] == record['pid'] and same['payloadPid'] == record['payloadPid'] and same['state'] == 'running'
                assert after['counters'][suffix + '/launches'] == '1'
            else:
                app_nodes(); adb('shell', 'input', 'keyevent', '3')
                assert stopped_flag()['stopped'] is False
                if operation == 'host-sigkill': kill_exact_host(host_before)
                elif operation == 'android-task-manager-stop': adb('shell', 'cmd', 'activity', 'stop-app', args.package)
                else: adb('shell', 'am', 'force-stop', args.package)
                wait_host_gone(host_before)
                item['packageBeforeReopen'] = stopped_flag()
                assert item['packageBeforeReopen']['stopped'] == (operation == 'force-stop')
                item['supervisorAfterDeath'] = child_observation(supervisor)
                item['payloadAfterDeath'] = child_observation(payload)
                after = observe(); item['hostAfter'] = host(after)
                assert item['hostAfter']['startTicks'] != host_before['startTicks'] or item['hostAfter']['pid'] != host_before['pid']
                same = process(after, suffix)
                assert same and same['id'] == record['id'] and same['pid'] == record['pid'] and same['state'] not in ('queued', 'starting', 'running')
                assert after['counters'][suffix + '/launches'] == '1', 'Cold reopen automatically relaunched a service'
                if item['payloadAfterDeath']['state'] == 'original-still-alive' or item['supervisorAfterDeath']['state'] == 'original-still-alive':
                    assert same['state'] == 'lost' and same.get('processMaySurvive'), 'A surviving service was silently adopted or falsely marked dead'
                item['recordAfterReopen'] = same
                item['foregroundAfterReopen'] = adb('shell', 'dumpsys', 'activity', 'services', args.package)
                assert 'ManagedProcessService' not in item['foregroundAfterReopen'], 'Cold reopen recreated an FGS without an explicit launch'
            launch('processes', id=record['id']); tap('process-stop'); stopped, ended = wait_process(suffix, 'exited')
            assert not ended.get('processMaySurvive') and stopped['counters'][suffix + '/launches'] == '1'
            item['explicitNormalStop'] = ended
            item['payloadAfterStop'] = child_observation(payload)
            assert item['payloadAfterStop']['state'] != 'original-still-alive', 'Explicit normal Stop left original payload alive'
            adb('forward', '--remove', 'tcp:' + str(host_port)); forwards.remove(host_port)
        assert len(evidence['cases']) == 4
        proof['checks'].append('Distinct Activity replacement, validated host death, Android Task Manager user-stop and force-stop preserve ownership truth and never auto-launch')

    try:
        package_path = adb('shell', 'pm', 'path', args.package).strip().splitlines()
        assert len(package_path) == 1 and package_path[0].startswith('package:')
        actual_hash = adb('shell', 'sha256sum', shlex.quote(package_path[0][8:])).split()[0]
        assert actual_hash == proof['apkSha256'], 'Installed APK identity differs'
        proof['device'] = {key: adb('shell', 'getprop', prop).strip() for key, prop in [('model', 'ro.product.model'), ('os', 'ro.build.version.release'), ('sdk', 'ro.build.version.sdk'), ('abi', 'ro.product.cpu.abi')]}
        adb('shell', 'pm', 'grant', args.package, 'android.permission.POST_NOTIFICATIONS')
        seed = observe('setup'); setup = True; fixture = seed['fixture']; proof['setup'] = seed
        def start_process(suffix, argv):
            list_page('processes', 'process-new'); tap('process-new'); field('进程名称', 'ui-' + run + '-' + suffix)
            tap('参数数组', 'Argument array'); field('启动参数 JSON', json.dumps(argv, separators=(',', ':')))
            tap('process-submit'); return wait_process(suffix, 'running')
        if args.lifecycle_only:
            proof['lifecyclePreflight'] = observe()
            assert not proof['lifecyclePreflight']['foreignActive'], 'Lifecycle-only refuses unrelated active services before deliberate host death'
            lifecycle_checks(fixture, start_process)
            proof['verified'] = True
            return
        echo, echo_record = start_process('echo', ['python', fixture['processFixture'], 'echo', fixture['directory'] + '/echo'])
        launch('processes', id=echo_record['id']); tap('stdout'); tap('读取日志', 'Read logs'); field('发送到标准输入', 'ui-input')
        tap('发送输入', 'Send input')
        for _ in range(8):
            tap('读取后续日志', 'Read next log page')
            rendered, _ = control(('process-log',))
            if 'input:ui-input' in rendered.get('text', ''): break
            time.sleep(.15)
        assert 'input:ui-input' in rendered.get('text', ''), 'Actual log UI did not render delivered input output'
        shot('process-log-input')
        echoed = observe(); assert 'input:ui-input' in echoed['logs']['ui-' + run + '-echo']
        launch('processes', id=echo_record['id']); tap('process-stop'); wait_process('echo', 'exited')
        proof['checks'].append('Production process form, log page, stdin and explicit stop verified against native state')
        http, http_record = start_process('http', ['python', fixture['mcpFixture'], 'http', fixture['directory'] + '/http'])
        for _ in range(30):
            observed = observe(); port = observed['counters']['http/port']
            if port: break
            time.sleep(.1)
        assert port.isdigit()
        list_page('mcp', 'mcp-new'); tap('mcp-new')
        json_field(json.dumps({'ui-' + run + '-stdio': {'command': 'python', 'args': [fixture['mcpFixture'], 'stdio', fixture['directory'] + '/stdio']}}, separators=(',', ':')))
        tap('mcp-edit-save'); time.sleep(1); before = observe(); local = next(item for item in before['mcps'] if item['name'].endswith('-stdio'))
        assert not local.get('processId') and not local.get('connection'), 'Save implicitly launched/connected'
        launch('mcp', id=local['id']); tap('mcp-start'); running, local_process = wait_process('stdio', 'running')
        launch('mcp', id=local['id']); tap('mcp-discover'); discovered, local = wait_mcp(local['id'], lambda item: item.get('toolCount', 0) >= 13 and item.get('connection', {}).get('state') == 'connected')
        assert local['toolCount'] >= 13 and local['connection']['state'] == 'connected'
        launch('mcp', id=local['id']); tap('mcp-discover'); tap('查看工具 echo', 'View tool echo'); schema, _ = control(('mcp-tool-schema',)); assert 'inputSchema' in schema.get('text', ''), 'Actual tool details did not render the schema'; shot('mcp-tool-schema'); tap('mcp-toggle')
        disabled, disabled_mcp = wait_mcp(local['id'], lambda item: not item['enabled']); assert process(disabled, 'stdio')['state'] == 'running' and not disabled_mcp['enabled']
        launch('mcp', id=local['id']); tap('mcp-toggle'); tap('mcp-discover'); tap('mcp-process'); shot('mcp-linked-process')
        reused = observe(); assert reused['counters']['stdio/launches'] == '1' and reused['counters']['stdio/initializations'] == '1'
        proof['checks'].append('Production stdio MCP save/start/discovery/schema/disable/re-enable/link controls preserve one process and initialization')
        list_page('mcp', 'mcp-new'); tap('mcp-new')
        json_field(json.dumps({'ui-' + run + '-remote': {'url': 'http://127.0.0.1:' + port + '/auth', 'headers': {'Authorization': 'Bearer fixture-token', 'X-Arxd-Fixture': 'fixture-header'}}}, separators=(',', ':')))
        tap('mcp-edit-save'); time.sleep(1); external = next(item for item in observe()['mcps'] if item['name'].endswith('-remote'))
        before_http = observe()
        proof['httpPolicyBefore'] = before_http['httpPolicy']
        if before_http['httpPolicy']['allowPlaintextHttp']:
            launch('settings'); tap('mcp-http-policy')
        blocked = observe(); blocked_remote = next(item for item in blocked['mcps'] if item['id'] == external['id'])
        assert not blocked['httpPolicy']['allowPlaintextHttp'] and blocked_remote['policyBlocked'] and blocked_remote['hasCredential']
        launch('settings'); tap('mcp-http-policy')
        opted = observe(); assert opted['httpPolicy']['allowPlaintextHttp']
        assert next(item for item in opted['mcps'] if item['id'] == external['id']).get('connection', {}).get('state') != 'connected', 'Enabling the policy must not connect automatically'
        launch('mcp', id=external['id']); tap('mcp-discover'); _, remote = wait_mcp(external['id'], lambda item: item.get('toolCount', 0) >= 13 and item.get('connection', {}).get('state') == 'connected')
        launch('settings'); tap('mcp-http-policy')
        off = observe(); retained = next(item for item in off['mcps'] if item['id'] == external['id'])
        assert not off['httpPolicy']['allowPlaintextHttp'] and retained['policyBlocked'] and retained['hasCredential'] and not retained.get('toolCount')
        assert process(off, 'http')['state'] == 'running' and process(off, 'stdio')['state'] == 'running'
        launch('settings'); tap('mcp-http-policy'); launch('mcp', id=external['id']); tap('mcp-discover')
        _, remote = wait_mcp(external['id'], lambda item: item.get('connection', {}).get('state') == 'connected')
        proof['checks'].append('Production settings HTTP toggle blocks by default/when OFF, retains credentials and processes, and requires explicit connect after ON')
        assert remote.get('hasCredential') and remote['toolCount'] >= 13 and remote['connection']['state'] == 'connected'
        launch('mcp', id=external['id']); shot('mcp-authenticated-http')
        proof['checks'].append('Production HTTP MCP JSON stores masked credentials and discovers actual authenticated server tools')
        before_stop = observe(); assert not before_stop['foreignActive']; proof['beforeNotificationStop'] = before_stop
        notification_tap(); shot('notification-process-entry'); notification_tap(stop=True)
        stopped = observe('stopped'); proof['notificationStopped'] = stopped
        for record in stopped['processes']:
            stat = stopped['identities'].get(record['id'], 'absent')
            if stat != 'absent':
                fields = stat.rsplit(') ', 1)[1].split()
                assert fields[0] in ('Z', 'X') or fields[19] != str(record['startTicks']), 'Original supervised identity still alive after Stop All'
        proof['checks'].append('Owned SystemUI notification opens production process management; its real Stop All terminates every tracked instance')
        adb('shell', 'am', 'force-stop', args.package)
        reopened = observe('stopped'); proof['reopened'] = reopened
        assert {record['id'] for record in reopened['processes']} == {record['id'] for record in stopped['processes']}
        assert reopened['counters']['stdio/launches'] == reopened['counters']['http/launches'] == '1'
        proof['checks'].append('Fresh App process preserves exited records and does not restart services')
        assert reopened['httpPolicy']['allowPlaintextHttp'], 'The actual UI ON decision did not survive a fresh App process'
        launch('settings'); tap('mcp-http-policy')
        disabled_ui = observe('stopped'); assert not disabled_ui['httpPolicy']['allowPlaintextHttp']
        adb('shell', 'am', 'force-stop', args.package)
        off_reopened = observe('stopped'); assert not off_reopened['httpPolicy']['allowPlaintextHttp']
        launch('settings')
        policy_control, _ = control(('mcp-http-policy',)); assert policy_control.get('checked') == 'false', 'The settings row must render the retained OFF decision'
        proof['httpPolicyReopened'] = {'on': reopened['httpPolicy'], 'off': off_reopened['httpPolicy']}
        if proof['httpPolicyBefore']['allowPlaintextHttp']:
            tap('mcp-http-policy')
        proof['checks'].append('Actual settings ON and OFF decisions survive separate fresh-process reopens; the row renders the retained value')
        if args.lifecycle: lifecycle_checks(fixture, start_process)
        proof['verified'] = True
    except Exception as error:
        proof['error'] = str(error)
        try: shot('failure', owned=False)
        except Exception as capture_error: proof['failureCaptureError'] = str(capture_error)
        raise
    finally:
        if notification_shade_opened:
            try:
                adb('shell', 'cmd', 'statusbar', 'collapse'); notification_shade_opened = False
                proof['notificationShadeCleanup'] = {'collapsed': True, 'openedByThisController': True}
            except Exception as error: proof['notificationShadeCleanupError'] = str(error); proof['verified'] = False
        # Restore while owned configs/processes still exist, before fixture cleanup.
        if 'httpPolicyBefore' in proof:
            try: restore_http_policy()
            except Exception as error: proof['httpPolicyRestorationError'] = str(error); proof['verified'] = False
        for port in forwards:
            try: adb('forward', '--remove', 'tcp:' + str(port))
            except Exception as error:
                proof.setdefault('forwardCleanupErrors', []).append(str(error)); proof['verified'] = False
        if setup:
            try: proof['cleanup'] = observe('cleanup')
            except Exception as error: proof['cleanupError'] = str(error); proof['verified'] = False
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'verified': proof['verified'], 'scope': scope, 'evidence': str(directory)}), flush=True)


if __name__ == '__main__':
    main()
