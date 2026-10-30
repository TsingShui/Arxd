#!/usr/bin/env python3
"""Verify official Termux repositories and stage the authenticated offline toolchain.

Requires host gpgv (GnuPG). Normal builds never refresh repository pins.
The original .deb files and their license files stay unmodified.
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
ROOT_URL = 'https://packages-cf.termux.dev/apt/termux-root/'
BASE_PACKAGES = ('uv', 'python', 'nodejs', 'npm', 'git', 'curl', 'android-tools', 'tshark', 'iproute2')


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


def verified_records(bootstrap, repository=None, index_path='main/binary-aarch64/Packages.gz'):
    repository = repository or REPOSITORY
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
    result = subprocess.run(['gpgv', '--status-fd', '1', *key_args, str(repository / 'InRelease')], check=True, text=True, capture_output=True)
    signatures = [line.split()[2] for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    assert signatures, 'No trusted repository signature'
    release = (repository / 'InRelease').read_text()
    section = release.split('SHA256:\n', 1)[1].split('\nSHA512:', 1)[0]
    expected = next(line.split() for line in section.splitlines() if line.endswith(' ' + index_path))
    compressed = (repository / 'Packages.gz').read_bytes()
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
    for name in BASE_PACKAGES:
        visit(name)
    return [found[name] for name in sorted(found)]


def data_archive(path):
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
            return tarfile.open(fileobj=io.BytesIO(payload))
    raise ValueError('Debian archive has no data payload')


def licenses(path):
    with data_archive(path) as archive:
        return [{'path': member.name.removeprefix('./data/data/com.termux/files/usr/'),
                 'sha256': sha(archive.extractfile(member).read()), 'bytes': member.size}
                for member in archive if member.isfile() and
                (Path(member.name).name.upper().startswith(('LICENSE', 'COPYING')) or Path(member.name).name == 'copyright')]


def member(archive, name, data):
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.external_attr = 0o100644 << 16
    archive.writestr(entry, data)


def fetch_artifact(url, identity, pending):
    subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--tlsv1.2',
                    '--connect-timeout', '10', '--max-time', '120',
                    '--speed-limit', '1024', '--speed-time', '30',
                    '--silent', '--show-error', url, '-o', str(pending)], check=True)
    assert pending.stat().st_size == int(identity['Size']) and sha(pending.read_bytes()) == identity['SHA256'], pending.name


def download_package(package, path):
    pending = path.with_suffix('.download')
    repository = package.get('Repository', 'main')
    assert repository in ('main', 'root'), 'Unknown package repository'
    bases = (URL, 'https://packages.termux.dev/apt/termux-main/') if repository == 'main' else (
        ROOT_URL, 'https://packages.termux.dev/apt/termux-root/')
    # Transport failures may fall back; a size/hash mismatch always fails closed.
    for index, base in enumerate(bases):
        try:
            fetch_artifact(base + package['Filename'], package, pending)
            pending.replace(path)
            return
        except subprocess.CalledProcessError:
            if index == len(bases) - 1:
                raise
        finally:
            pending.unlink(missing_ok=True)


def host_tools():
    paths = ['bin/ecapture']
    files = [(path, SOURCE / 'tools' / path) for path in paths]
    files.append(('share/arxd/ecapture.json', SOURCE / 'ecapture.json'))
    return [{'Path': name, 'Size': path.stat().st_size, 'SHA256': sha(path.read_bytes()),
             'Executable': name.startswith('bin/')} for name, path in files]


def stage(bootstrap, refresh=False):
    index = {}
    repositories = []
    for name, url, directory, index_path in (
        ('main', URL, REPOSITORY, 'main/binary-aarch64/Packages.gz'),
        ('root', ROOT_URL, REPOSITORY / 'root', 'stable/binary-aarch64/Packages.gz'),
    ):
        packages, signatures = verified_records(bootstrap, directory, index_path)
        for package_name, package in packages.items():
            index.setdefault(package_name, package | {'Repository': name})
        repositories.append({'name': name, 'url': url, 'indexPath': index_path,
                             'inReleaseSha256': sha((directory / 'InRelease').read_bytes()),
                             'packagesSha256': sha((directory / 'Packages.gz').read_bytes()),
                             'trustedSignatures': signatures})
    packages = closure(index)
    lock_path = SOURCE / 'runtime-packages.json'
    fields = ('Package', 'Version', 'Architecture', 'Repository', 'Filename', 'Size', 'SHA256', 'Installed-Size', 'Homepage')
    lock = {'schemaVersion': 2, 'architecture': 'aarch64', 'minimumAndroidApi': 29,
            'repositories': repositories, 'bootstrapSha256': sha(bootstrap.read_bytes()),
            'hostTools': host_tools(),
            'packages': [{key: package[key] for key in fields if key in package} |
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
        for tool in lock['hostTools']:
            path = SOURCE / 'ecapture.json' if tool['Path'] == 'share/arxd/ecapture.json' else SOURCE / 'tools' / tool['Path']
            member(archive, 'host-tools/' + tool['Path'], path.read_bytes())
        for repository in repositories:
            directory = REPOSITORY if repository['name'] == 'main' else REPOSITORY / 'root'
            for name in ('InRelease', 'Packages.gz'):
                member(archive, 'repository/' + repository['name'] + '/' + name, (directory / name).read_bytes())
    temporary.replace(bundle)
    manifest = {**lock, 'bundleSha256': sha(bundle.read_bytes()), 'bundleBytes': bundle.stat().st_size,
                'packageLicenses': package_licenses, 'installedKiB': sum(int(package['Installed-Size']) for package in packages),
                'licensePolicy': 'Unmodified package archives are retained, including their original installed licenses and source notices.'}
    (assets / 'termux-runtime-packages.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', type=Path, required=True)
    parser.add_argument('--refresh-lock', action='store_true', help='Explicitly record the reviewed authenticated metadata snapshot')
    args = parser.parse_args()
    print(json.dumps(stage(args.bootstrap, args.refresh_lock), indent=2))
