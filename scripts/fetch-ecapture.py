#!/usr/bin/env python3
"""Stage the pinned upstream Android eCapture executable without changing its bytes."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'native/preload/ecapture.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_download(url, expected, destination):
    if not destination.exists():
        pending = destination.with_suffix('.download')
        try:
            subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--tlsv1.2',
                            '--connect-timeout', '10', '--max-time', '180', '--silent', '--show-error',
                            url, '-o', str(pending)], check=True)
            if digest(pending.read_bytes()) != expected:
                raise ValueError('eCapture download SHA-256 mismatch')
            pending.replace(destination)
        finally:
            pending.unlink(missing_ok=True)
    if digest(destination.read_bytes()) != expected:
        raise ValueError('Cached eCapture artifact SHA-256 mismatch')


def validate_binary(data, pin):
    if len(data) != pin['bytes'] or digest(data) != pin['sha256']:
        raise ValueError('eCapture executable identity mismatch')
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', data, 18)[0] != 183:
        raise ValueError('Expected the official Android ARM64 ELF executable')


def stage():
    pin = json.loads(PIN.read_text())
    if pin['schemaVersion'] != 1 or pin['target'] != 'android-arm64':
        raise ValueError('Unsupported eCapture pin')
    base = 'https://github.com/gojue/ecapture/releases/download/v' + pin['version'] + '/'
    if not pin['archive']['url'].startswith(base) or not pin['checksums']['url'].startswith(base):
        raise ValueError('eCapture must use the pinned official release')
    downloads = ROOT / 'target/arxd/preload/downloads/ecapture'
    downloads.mkdir(parents=True, exist_ok=True)
    checksums = downloads / 'checksums.txt'
    verified_download(pin['checksums']['url'], pin['checksums']['sha256'], checksums)
    entries = {line.split()[-1].lstrip('*'): line.split()[0] for line in checksums.read_text().splitlines() if line.strip()}
    if entries.get(pin['archive']['filename']) != pin['archive']['sha256']:
        raise ValueError('Upstream eCapture checksum does not match the reviewed pin')
    archive = downloads / pin['archive']['filename']
    verified_download(pin['archive']['url'], pin['archive']['sha256'], archive)
    if archive.stat().st_size != pin['archive']['bytes']:
        raise ValueError('eCapture archive size mismatch')
    with tarfile.open(archive) as source:
        executable = source.getmember(pin['binary']['member'])
        license_file = source.getmember(pin['licenseMember'])
        if not executable.isfile() or not license_file.isfile():
            raise ValueError('eCapture release members must be regular files')
        data = source.extractfile(executable).read()
        license_text = source.extractfile(license_file).read()
    validate_binary(data, pin['binary'])
    native = ROOT / 'target/arxd/native/arm64-v8a'
    metadata = ROOT / 'target/arxd/native-metadata'
    native.mkdir(parents=True, exist_ok=True)
    metadata.mkdir(parents=True, exist_ok=True)
    # Android permits executing installed native-library files. Do not try to
    # run this static Go ELF via linker64 or from the writable Termux prefix.
    pending = native / 'libecapture.so.staging'
    pending.write_bytes(data)
    pending.chmod(0o755)
    pending.replace(native / 'libecapture.so')
    (metadata / 'ecapture-build.json').write_text(json.dumps(pin, indent=2) + '\n')
    (metadata / 'ecapture-LICENSE.txt').write_bytes(license_text)
    return pin


if __name__ == '__main__':
    print(json.dumps(stage(), indent=2))
