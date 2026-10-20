#!/usr/bin/env python3
"""Verify the pinned official Termux repository and stage the offline .deb closure.

Requires host gpgv (GnuPG). Package metadata snapshots are unmodified signed
upstream evidence; normal builds never refresh pins or silently resolve latest.
"""
import argparse
import gzip
import hashlib
import json
import io
import tarfile
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'native/preload'
REPOSITORY = ROOT / 'prebuilt/arxd/repository'
OUTPUT = ROOT / 'target/arxd/preload'
URL = 'https://packages-cf.termux.dev/apt/termux-main/'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def records(text):
    output = {}
    for paragraph in text.strip().split('\n\n'):
        fields = {}
        last = None
        for line in paragraph.splitlines():
            if line.startswith(' ') and last:
                fields[last] += '\n' + line
            elif ': ' in line:
                last, value = line.split(': ', 1)
                fields[last] = value
        if 'Package' in fields:
            output[fields['Package']] = fields
    return output


def verified_records(bootstrap):
    pin = json.loads((SOURCE / 'bootstrap.json').read_text())
    assert bootstrap.stat().st_size == pin['bytes'] and sha(bootstrap.read_bytes()) == pin['sha256'], 'Bootstrap identity mismatch'
    keys = OUTPUT / 'keys'
    keys.mkdir(parents=True, exist_ok=True)
    key_args = []
    with zipfile.ZipFile(bootstrap) as archive:
        for name in sorted(archive.namelist()):
            if name.startswith('share/termux-keyring/') and name.endswith('.gpg'):
                key = keys / Path(name).name
                key.write_bytes(archive.read(name))
                key_args += ['--keyring', str(key)]
    result = subprocess.run(['gpgv', '--status-fd', '1', *key_args, str(REPOSITORY / 'InRelease')], check=True, text=True, capture_output=True)
    signatures = [line.split()[2] for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    assert signatures, 'No trusted repository signature'
    release = (REPOSITORY / 'InRelease').read_text()
    section = release.split('SHA256:\n', 1)[1].split('\nSHA512:', 1)[0]
    expected = next(line.split() for line in section.splitlines() if line.endswith(' main/binary-aarch64/Packages.gz'))
    compressed = (REPOSITORY / 'Packages.gz').read_bytes()
    assert sha(compressed) == expected[0] and len(compressed) == int(expected[1]), 'Signed package-index identity mismatch'
    return records(gzip.decompress(compressed).decode()), signatures


def closure(index):
    found = {}
    def visit(name):
        if name in found:
            return
        package = index[name]
        assert package['Architecture'] in ('all', 'aarch64')
        found[name] = package
        for field in ('Pre-Depends', 'Depends'):
            for dependency in package.get(field, '').split(','):
                if not dependency.strip():
                    continue
                alternatives = [re.split(r'[\s(:]', item.strip())[0] for item in dependency.split('|')]
                selected = next((item for item in alternatives if item in found), None)
                selected = selected or next((item for item in alternatives if item in index), None)
                assert selected, (name, dependency)
                visit(selected)
    for name in ('uv', 'python', 'nodejs', 'npm', 'git'):
        visit(name)
    return [found[name] for name in sorted(found)]


def licenses(path):
    data = path.read_bytes()
    assert data.startswith(b'!<arch>\n'), 'Invalid Debian archive'
    offset = 8
    while offset < len(data):
        header = data[offset:offset + 60]
        size = int(header[48:58])
        name = header[:16].decode().strip().rstrip('/')
        payload = data[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2
        if name.startswith('data.tar'):
            with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
                return [{'path': member.name.removeprefix('./data/data/com.termux/files/usr/'),
                         'sha256': sha(archive.extractfile(member).read()), 'bytes': member.size}
                        for member in archive if member.isfile() and
                        (Path(member.name).name.upper().startswith(('LICENSE', 'COPYING')) or Path(member.name).name == 'copyright')]
    raise ValueError('Debian archive has no data payload')


def member(archive, name, data):
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.external_attr = 0o100644 << 16
    archive.writestr(entry, data)


def download_package(package, path):
    pending = path.with_suffix('.download')
    # Both are official Termux endpoints. Only transport failures may fall back;
    # the signed snapshot's exact size/digest must match on either endpoint.
    for base in (URL, 'https://packages.termux.dev/apt/termux-main/'):
        try:
            subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--tlsv1.2',
                            '--connect-timeout', '10', '--max-time', '120',
                            '--speed-limit', '1024', '--speed-time', '30',
                            '--silent', '--show-error', base + package['Filename'],
                            '-o', str(pending)], check=True)
            assert pending.stat().st_size == int(package['Size']) and sha(pending.read_bytes()) == package['SHA256'], path.name
            pending.replace(path)
            return
        except subprocess.CalledProcessError:
            if base != URL:
                raise
        finally:
            pending.unlink(missing_ok=True)


def stage(bootstrap, refresh=False):
    index, signatures = verified_records(bootstrap)
    packages = closure(index)
    lock_path = SOURCE / 'runtime-packages.json'
    lock = {'schemaVersion': 1, 'architecture': 'aarch64', 'minimumAndroidApi': 29,
            'repository': URL, 'repositoryInReleaseSha256': sha((REPOSITORY / 'InRelease').read_bytes()),
            'repositoryPackagesSha256': sha((REPOSITORY / 'Packages.gz').read_bytes()),
            'trustedSignatures': signatures, 'bootstrapSha256': sha(bootstrap.read_bytes()),
            'packages': [{key: package[key] for key in ('Package', 'Version', 'Architecture', 'Filename', 'Size', 'SHA256', 'Installed-Size', 'Homepage') if key in package} |
                         {'Depends': package.get('Depends', ''), 'Pre-Depends': package.get('Pre-Depends', '')} for package in packages]}
    if refresh:
        lock_path.write_text(json.dumps(lock, indent=2) + '\n')
    assert json.loads(lock_path.read_text()) == lock, 'Runtime lock differs from authenticated repository snapshot; explicit pin review required'
    downloads = OUTPUT / 'downloads/packages'
    downloads.mkdir(parents=True, exist_ok=True)
    assets = OUTPUT / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    bundle = assets / 'termux-runtime-packages.zip'
    temporary = bundle.with_suffix('.tmp')
    package_licenses = {}
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED) as archive:
        for package in lock['packages']:
            name = Path(package['Filename']).name
            path = downloads / name
            if not path.exists():
                download_package(package, path)
            assert path.stat().st_size == int(package['Size']) and sha(path.read_bytes()) == package['SHA256'], name
            package_licenses[package['Package']] = licenses(path)
            member(archive, name, path.read_bytes())
        member(archive, 'repository/InRelease', (REPOSITORY / 'InRelease').read_bytes())
        member(archive, 'repository/Packages.gz', (REPOSITORY / 'Packages.gz').read_bytes())
    temporary.replace(bundle)
    manifest = {**lock, 'bundleSha256': sha(bundle.read_bytes()), 'bundleBytes': bundle.stat().st_size,
                'packageLicenses': package_licenses, 'installedKiB': sum(int(package['Installed-Size']) for package in packages),
                'licensePolicy': 'Unmodified upstream .deb copyright/license files installed under usr/share/doc; original package archives and signed repository evidence retained in APK.'}
    (assets / 'termux-runtime-packages.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', type=Path, required=True)
    parser.add_argument('--refresh-lock', action='store_true', help='Explicitly record the reviewed authenticated metadata snapshot')
    args = parser.parse_args()
    print(json.dumps(stage(args.bootstrap, args.refresh_lock), indent=2))
