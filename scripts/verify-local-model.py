#!/usr/bin/env python3
"""Run real Qwen -> Pi -> rxd on an isolated verification-enabled Android build."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--download', action='store_true', help='Explicitly download the pinned 1.28 GB model first')
    parser.add_argument('--model-file', type=Path, help='Stage exact pinned weights through the gated fixture seam; does NOT verify HTTPS downloading')
    parser.add_argument('--import-fixture', action='store_true', help='Exercise the real GGUF import + compatibility probe through the gated ADB fixture; does NOT verify HTTPS downloading or the system picker')
    parser.add_argument('--thinking', action='store_true', help='Additionally run one tool loop with the medium thinking level (requires template support)')
    parser.add_argument('--trials', type=int, default=2)
    args = parser.parse_args()
    if args.package == 'art.tsingshui.arxd' or not args.package.startswith('art.tsingshui.arxd.'):
        parser.error('Use an isolated verification package, never production')
    if not 1 <= args.trials <= 5:
        parser.error('--trials must be 1..5')
    if args.download and (args.model_file or args.import_fixture):
        parser.error('--download cannot be combined with a fixture transport')
    if args.import_fixture and not args.model_file:
        args.model_file = ROOT / 'target/arxd/qwen-research/Qwen3.5-2B-Q4_K_M.gguf'
        if not args.model_file.is_file():
            parser.error('--import-fixture needs --model-file or the research GGUF under target/')
    directory = ROOT / 'target/arxd/local-model-evidence' / str(uuid.uuid4())
    directory.mkdir(parents=True)

    def adb(*command):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=True, timeout=90)
        result.check_returncode()
        return result.stdout

    def run(action, event, timeout, restart=True):
        if restart:
            adb('shell', 'am', 'force-stop', args.package)
        adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
        adb('shell', 'wm', 'dismiss-keyguard')
        # No global logcat clearing: ignore entries before the bounded action.
        stamp = adb('shell', 'date', '+%m-%d\ %H:%M:%S.000').strip()
        uri = f'arxd:///?action={action}&requestId={uuid.uuid4()}'
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', shlex.quote(uri), '-n', args.package + '/.MainActivity')
        deadline = time.monotonic() + timeout
        memory = []
        while time.monotonic() < deadline:
            pid = adb('shell', 'pidof', args.package).strip()
            if not pid:
                raise RuntimeError('App process exited')
            logs = adb('logcat', '-d', '--pid=' + pid, '-T', stamp, '-v', 'raw', '-s', 'ArxdVerify:I', 'ReactNativeJS:E', '*:S')
            (directory / (action + '.log')).write_text(logs)
            meminfo = adb('shell', 'dumpsys', 'meminfo', args.package)
            memory.append({'at': time.time(), 'meminfo': meminfo})
            (directory / (action + '-memory.json')).write_text(json.dumps(memory))
            for line in reversed(logs.splitlines()):
                try:
                    result = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if result.get('event') == event and result.get('action') == action:
                    if not result.get('verified'):
                        raise AssertionError(result)
                    return result
            time.sleep(2)
        raise TimeoutError(f'{action} did not produce {event}; inspect {directory}')

    apk = ROOT / 'android/app/build/outputs/apk/release/app-release.apk'
    proof = {'verified': False, 'package': args.package, 'hardware': adb('shell', 'getprop', 'ro.product.model').strip(), 'conditions': 'Release CPU path; process-cold model each trial; OS page cache not flushed; foreground; durationMs covers the workspace action after workspace initialization, not Activity startup; meminfo sampled every 2s; no cloud provider; fixture transports stage the pinned SHA-256 over ADB and do not prove HTTPS download or the system picker', 'trials': []}
    if apk.exists():
        proof['localBuildApkSha256'] = hashlib.sha256(apk.read_bytes()).hexdigest()
    staged = None
    try:
        if args.model_file:
            manifest = json.loads((ROOT / 'modules/rxd/android/src/main/assets/qwen-model.json').read_text())
            digest = hashlib.sha256()
            with args.model_file.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
            if args.model_file.stat().st_size != manifest['bytes'] or digest.hexdigest() != manifest['sha256']:
                raise ValueError('Model fixture does not match the pinned manifest')
            staged = '/data/local/tmp/arxd-qwen-' + args.package + '.gguf'
            adb('push', str(args.model_file), staged)
            if args.import_fixture:
                proof['importRemove'] = run('ui-local-remove', 'arxd-local-remove', 90)
                proof['import'] = run('ui-local-import', 'arxd-local-import', 420)
            else:
                proof['download'] = run('ui-local-stage', 'arxd-local-download', 150)
        elif args.download:
            proof['download'] = run('ui-local-download', 'arxd-local-download', 1900)
        for index in range(args.trials):
            proof['trials'].append(run(f'ui-local-probe-{index}', 'arxd-local-result', 240))
        if args.thinking:
            proof['thinking'] = run('ui-local-thinking', 'arxd-local-result', 300)
        proof['release'] = run('ui-local-release', 'arxd-local-release', 30, restart=False)
        proof['cancellation'] = run('ui-local-cancel', 'arxd-local-result', 90, restart=False)
        proof['verified'] = True
    finally:
        if staged:
            adb('shell', 'rm', '-f', staged)
        (directory / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        print(directory)
    print(json.dumps(proof, ensure_ascii=False))


if __name__ == '__main__':
    main()
