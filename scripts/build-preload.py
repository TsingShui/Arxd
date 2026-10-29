#!/usr/bin/env python3
"""Build the Android-only relocation shim and stage an unchanged official bootstrap."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'native/preload'
OUTPUT = ROOT / 'target/arxd'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    pin = json.loads((SOURCE / 'bootstrap.json').read_text())
    archive = OUTPUT / 'preload/downloads/bootstrap-aarch64.zip'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix('.download')
        with urllib.request.urlopen(pin['url'], timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if digest(temporary) != pin['sha256']:
            raise RuntimeError('Official bootstrap SHA-256 mismatch')
        temporary.replace(archive)
    if archive.stat().st_size != pin['bytes'] or digest(archive) != pin['sha256']:
        raise RuntimeError('Official bootstrap identity mismatch')
    sdk = Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk'))
    ndk = Path(os.environ.get('ANDROID_NDK_HOME', sdk / 'ndk/28.2.13676358'))
    host = next((ndk / 'toolchains/llvm/prebuilt').glob('*'))
    compiler = host / 'bin/aarch64-linux-android29-clang'
    binary = OUTPUT / 'native/arm64-v8a/libarxdpreload.so'
    binary.parent.mkdir(parents=True, exist_ok=True)
    upstream = ROOT / 'third_party/termux-exec'
    sources = [SOURCE / 'compat.c', upstream / 'ExecIntercept.c', upstream / 'ExecVariantsIntercept.c']
    subprocess.run([str(compiler), '-std=gnu11', '-O2', '-fPIC', '-shared', '-Wall', '-Wextra', '-Werror',
                    '-I', str(SOURCE), '-I', str(upstream),
                    '-Wl,-z,max-page-size=16384', '-Wl,--no-undefined', *map(str, sources), '-ldl', '-o', str(binary)], check=True)
    assets = OUTPUT / 'preload/assets'
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(archive, assets / 'termux-bootstrap.zip')
    shutil.copyfile(SOURCE / 'probes.json', assets / 'termux-probes.json')
    shutil.copyfile(SOURCE / 'toolchain-probe.sh', assets / 'termux-toolchain-probe.sh')
    notices = (upstream / 'REFERENCE.md').read_text() + '\n' + (upstream / 'LICENSE-APACHE-2.0').read_text()
    notices += '\n' + (upstream / 'ExecVariantsIntercept.c').read_text().split('#define _GNU_SOURCE', 1)[0]
    license_root = SOURCE / 'licenses'
    for license_file in sorted(license_root.glob('*.txt')):
        notices += '\n\n=== ' + license_file.name + ' ===\n' + license_file.read_text()
    notices += '\n\n=== Frida source identities ===\n' + (license_root / 'frida-sources.json').read_text()
    (assets / 'arxd-runtime-notices.txt').write_text(notices)
    manifest = {**pin, 'shimSha256': digest(binary), 'sourceSha256': digest(SOURCE / 'compat.c'),
                'sourceFiles': {str(p.relative_to(ROOT)): digest(p) for p in
                                [*sources, SOURCE / 'arxd_exec.h', upstream / 'ExecIntercept.h', upstream / 'ExecVariantsIntercept.h', upstream / 'upstream.json']},
                'termuxExecRevision': json.loads((upstream / 'upstream.json').read_text())['revision'],
                'minimumAndroidApi': 29, 'ndk': ndk.name}
    with zipfile.ZipFile(archive) as bootstrap:
        manifest['executablePaths'] = [entry.filename for entry in bootstrap.infolist()
                                       if not entry.is_dir() and (entry.external_attr >> 16) & 0o111]
    (assets / 'termux-bootstrap.json').write_text(json.dumps(manifest, indent=2) + '\n')
    package_spec = importlib.util.spec_from_file_location('runtime_packages', ROOT / 'scripts/runtime-packages.py')
    packages = importlib.util.module_from_spec(package_spec)
    package_spec.loader.exec_module(packages)
    capture_spec = importlib.util.spec_from_file_location('ecapture_assets', ROOT / 'scripts/fetch-ecapture.py')
    capture = importlib.util.module_from_spec(capture_spec)
    capture_spec.loader.exec_module(capture)
    capture.stage()
    runtime = packages.stage(archive)
    print(json.dumps({'runtimeBundleSha256': runtime['bundleSha256'], 'library': str(binary), 'assets': str(assets), **manifest}))


if __name__ == '__main__':
    main()
