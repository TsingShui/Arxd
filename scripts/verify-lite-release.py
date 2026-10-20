#!/usr/bin/env python3
"""Gate a Lite release on its actual APK contents, product manifest and signing certificate."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERIFICATION_KEY = 'art.tsingshui.arxd.ENABLE_VERIFICATION'
REQUIRED_ASSETS = {
    'lib/arm64-v8a/libarxdpreload.so',
    'lib/arm64-v8a/librnllama.so', 'lib/arm64-v8a/librnllama_v8.so',
    'lib/arm64-v8a/librnllama_jni.so', 'lib/arm64-v8a/librnllama_jni_v8.so',
    'assets/termux-bootstrap.zip', 'assets/termux-bootstrap.json',
    'assets/termux-runtime-packages.zip', 'assets/termux-runtime-packages.json',
    'assets/termux-toolchain-probe.sh',
    'assets/codemode/host.mjs', 'assets/codemode/quickjs.wasm', 'assets/codemode/manifest.json',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_contents(names):
    require(len(names) == len(set(names)), 'APK contains duplicate ZIP entries')
    require(not any(name.endswith('/librxd.so') for name in names), 'Lite APK unexpectedly contains the rxd engine')
    require(REQUIRED_ASSETS <= set(names), 'Lite APK is missing required shell, inference or CodeMode assets')


def check_manifest(badging, tree, config):
    android = config['expo']['android']
    identity = dict(re.findall(r"(?:^|\s)(name|versionCode|versionName)='([^']*)'", badging.splitlines()[0]))
    require(identity == {'name': android['package'], 'versionCode': str(android.get('versionCode', 1)),
                         'versionName': config['expo']['version']}, 'APK identity or version differs from app.json')
    require('application-debuggable' not in badging, 'Release APK is debuggable')
    blocks = re.split(r'(?m)^\s*E: ', tree)
    application = [block for block in blocks if block.startswith('application ')]
    require(len(application) == 1, 'Expected one application manifest element')
    require(not re.search(r'android:testOnly\([^)]*\)=\(type 0x12\)0xffffffff', application[0]), 'Release APK is test-only')
    flags = [block for block in blocks if block.startswith('meta-data ') and
             re.search(r'android:name\([^)]*\)="' + re.escape(VERIFICATION_KEY) + '"', block)]
    require(len(flags) == 1 and re.search(r'android:value\([^)]*\)=\(type 0x12\)0x0+\b', flags[0]),
            'Product verification entry points are not explicitly disabled')


def check_certificate(signature, expected):
    require(re.search(r'^Number of signers:\s*1\s*$', signature, re.M), 'Expected exactly one APK signer')
    # Build-tools 37 reports each scheme as "V2 Signer:"; older tools use
    # "Signer #1". Repeated schemes must all resolve to the same certificate.
    signers = re.findall(r'^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?:)\s+certificate SHA-256 digest:\s*([a-fA-F0-9]+)\s*$', signature, re.M)
    require({value.lower() for value in signers} == {expected}, 'APK signer differs from the configured release certificate')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True, type=Path)
    parser.add_argument('--keystore', required=True, type=Path)
    parser.add_argument('--alias', required=True)
    args = parser.parse_args()
    config = json.loads((ROOT / 'app.json').read_text())
    package = json.loads((ROOT / 'package.json').read_text())
    require(config['expo']['version'] == package['version'], 'app.json and package.json versions differ')
    with zipfile.ZipFile(args.apk) as archive:
        check_contents(archive.namelist())
    badging = subprocess.check_output(['aapt', 'dump', 'badging', str(args.apk)], text=True)
    tree = subprocess.check_output(['aapt', 'dump', 'xmltree', str(args.apk), 'AndroidManifest.xml'], text=True)
    check_manifest(badging, tree, config)
    # Export only the public certificate. Passwords stay in the environment, never argv or logs.
    certificate = subprocess.check_output(['keytool', '-exportcert', '-keystore', str(args.keystore),
                                           '-alias', args.alias, '-storepass:env', 'ARXD_RELEASE_STORE_PASSWORD'])
    expected = hashlib.sha256(certificate).hexdigest()
    signature = subprocess.check_output(['apksigner', 'verify', '--verbose', '--print-certs', str(args.apk)], text=True)
    check_certificate(signature, expected)
    checksum = hashlib.sha256()
    with args.apk.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    release = json.loads((args.apk.parent / 'release.json').read_text())
    require(release['engine'] is None and len(release['artifacts']) == 1, 'Expected Lite-only release metadata')
    artifact = release['artifacts'][0]
    require(artifact['variant'] == 'lite' and artifact['withRxd'] is False and artifact['file'] == args.apk.name
            and artifact['sha256'] == digest and artifact['bytes'] == args.apk.stat().st_size,
            'Release metadata does not match the verified Lite APK')
    print(json.dumps({'verified': True, 'variant': 'lite', 'package': config['expo']['android']['package'],
                      'version': package['version'], 'apkSha256': digest, 'certificateSha256': expected,
                      'verificationEnabled': False, 'rxdBundled': False}, indent=2))


if __name__ == '__main__':
    main()
