#!/usr/bin/env python3
"""Actual Android opt-out URI rejection; isolated package only, no App credentials."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shlex
import subprocess
import struct
import threading
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--apk', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'art\.tsingshui\.arxd\.[a-z][a-z0-9_]*', args.package):
        parser.error('Only an intentionally isolated verification-disabled package is permitted')
    directory = Path(__file__).resolve().parents[3] / 'target/arxd/verification-gate-evidence' / uuid.uuid4().hex
    directory.mkdir(parents=True)
    proof = {'verified': False, 'package': args.package, 'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'requests': [], 'rejected': []}

    def adb(*command):
        return subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=True, check=True, timeout=30).stdout

    def snapshot():
        # Only names, sizes and mtimes in this dedicated package. The sole content
        # read below is a bounded AndroidX framework cache, never keys or user files.
        command = f'for d in /data/user/0/{args.package}/files /data/user/0/{args.package}/databases; do if test -d "$d"; then find "$d" \\( -type f -o -type l \\) -exec stat -c "%n %s %Y" {{}} \\; ; fi; done'
        return sorted(adb('shell', 'su', '-c', shlex.quote(command)).splitlines())

    profile_path = f'/data/user/0/{args.package}/files/profileInstalled'

    def profile_snapshot(rows):
        metadata = [row for row in rows if row.rsplit(' ', 2)[0] == profile_path]
        assert len(metadata) <= 1, 'Duplicate AndroidX profile cache metadata'
        if not metadata:
            return None
        # AndroidX ProfileInstaller 1.3.1 runs after the first frame, including a
        # rejected cold URI. ProfileVerifier.Cache writes exactly >iiqq (24 bytes).
        # Cache.equals includes status/current-profile size, so later launches can
        # legitimately rewrite it. Parse both sides; never exempt malformed data.
        # Source: Google's Maven profileinstaller-1.3.1-sources.jar, ProfileVerifier.java.
        assert metadata[0].rsplit(' ', 2)[1] == '24', 'Unexpected AndroidX profile cache size'
        quoted = shlex.quote(profile_path)
        command = f'if test -f {quoted} && ! test -L {quoted}; then od -An -tx1 -N25 {quoted}; else exit 1; fi'
        raw = bytes.fromhex(adb('shell', 'su', '-c', shlex.quote(command)))
        assert len(raw) == 24, 'Unexpected AndroidX profile cache format'
        schema, result, updated, size = struct.unpack('>iiqq', raw)
        assert schema == 1 and result in range(4), 'Unexpected AndroidX profile cache schema/result'
        assert 0 < updated <= (time.time() + 60) * 1000 and size >= 0, 'Invalid AndroidX profile cache values'
        return {
            'path': profile_path, 'metadata': metadata[0], 'schema': schema,
            'resultCode': result, 'packageLastUpdateTime': updated,
            'installedCurrentProfileSize': size,
        }

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            proof['requests'].append(self.path)
            self.send_response(500); self.end_headers()
        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    mapped = False
    try:
        installed = adb('shell', 'pm', 'path', args.package).strip().removeprefix('package:')
        assert adb('shell', 'sha256sum', shlex.quote(installed)).split()[0] == proof['apkSha256']
        assert 'tcp:18759' not in adb('reverse', '--list'), 'Never replace an existing acceptance fixture mapping'
        adb('reverse', 'tcp:18759', f'tcp:{server.server_port}'); mapped = True
        adb('shell', 'am', 'force-stop', args.package)
        proof['before'] = snapshot()
        proof['frameworkBefore'] = profile_snapshot(proof['before'])
        for route in ['verify-retry?case=network1&run=gate', 'verify-services?run=gate', 'verify-service-safety', 'verify-mcp', 'verify-services-ui', 'verify', '/?action=ui-live-send', '/?action=ui-shared-skills-probe', '/?action=ui-context-capacity']:
            adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote('arxd://' + route), '-n', args.package + '/.MainActivity')
            time.sleep(.4)
            path = '/data/local/tmp/arxd-verification-gate.xml'
            adb('shell', 'uiautomator', 'dump', path)
            ui = adb('shell', 'cat', path)
            (directory / f'blocked-{len(proof["rejected"])}.xml').write_text(ui)
            assert 'Verification is disabled in this build' in ui, route
            proof['rejected'].append(route)
        proof['after'] = snapshot()
        proof['frameworkAfter'] = profile_snapshot(proof['after'])
        before, after = proof['frameworkBefore'], proof['frameworkAfter']
        proof['allowedFrameworkDelta'] = []
        if before:
            assert after, 'Disabled verification removed the AndroidX profile cache'
            assert before['packageLastUpdateTime'] == after['packageLastUpdateTime'], 'AndroidX cache package identity changed'
        if before != after:
            proof['allowedFrameworkDelta'].append({
                'path': profile_path, 'change': 'updated' if before else 'created',
                'before': before, 'after': after,
            })
        proof['workspaceBefore'] = [row for row in proof['before'] if not before or row != before['metadata']]
        proof['workspaceAfter'] = [row for row in proof['after'] if not after or row != after['metadata']]
        assert proof['workspaceBefore'] == proof['workspaceAfter'], 'Disabled verification created or modified App workspace/database files'
        assert not proof['requests'], 'Disabled verification reached the model fixture'
        proof['verified'] = True
    finally:
        if mapped:
            adb('reverse', '--remove', 'tcp:18759')
        server.shutdown(); server.server_close()
        (directory / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps({'verified': proof['verified'], 'evidence': str(directory)}))


if __name__ == '__main__':
    main()
