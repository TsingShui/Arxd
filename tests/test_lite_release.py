"""Release gate policy tests; no fixture bytes are presented as real APK verification."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('lite_release', Path(__file__).resolve().parents[1] / 'scripts/verify-lite-release.py')
lite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lite)

CONFIG = {'expo': {'version': '0.1.0', 'android': {'package': 'art.tsingshui.arxd', 'versionCode': 1}}}
BADGING = "package: name='art.tsingshui.arxd' versionCode='1' versionName='0.1.0' compileSdkVersion='37' compileSdkVersionCodename='17'\n"
TREE = '''N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    E: application (line=10)
      A: android:debuggable(0x0101000f)=(type 0x12)0x0
      E: meta-data (line=11)
        A: android:name(0x01010003)="art.tsingshui.arxd.ENABLE_VERIFICATION"
        A: android:value(0x01010024)=(type 0x12)0x0
      E: activity (line=12)
        A: android:name(0x01010003)=".MainActivity"
'''


class LiteReleaseTests(unittest.TestCase):
    def test_complete_lite_runtime_is_accepted(self):
        lite.check_contents(list(lite.REQUIRED_ASSETS))
        lite.check_manifest(BADGING, TREE, CONFIG)

    def test_engine_cannot_be_shipped(self):
        with self.assertRaisesRegex(ValueError, 'rxd engine'):
            lite.check_contents([*lite.REQUIRED_ASSETS, 'lib/arm64-v8a/librxd.so'])

    def test_every_shell_and_codemode_asset_is_required(self):
        for asset in lite.REQUIRED_ASSETS:
            with self.subTest(asset=asset), self.assertRaisesRegex(ValueError, 'missing required'):
                lite.check_contents(list(lite.REQUIRED_ASSETS - {asset}))

    def test_duplicate_archive_members_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            lite.check_contents([*lite.REQUIRED_ASSETS, next(iter(lite.REQUIRED_ASSETS))])

    def test_wrong_package_and_versions_are_rejected(self):
        for old, new in [('art.tsingshui.arxd', 'art.tsingshui.arxd.quality'), ("versionCode='1'", "versionCode='2'"), ("versionName='0.1.0'", "versionName='0.2.0'")]:
            with self.subTest(change=new), self.assertRaisesRegex(ValueError, 'identity or version'):
                lite.check_manifest(BADGING.replace(old, new), TREE, CONFIG)

    def test_debuggable_and_test_only_apks_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'debuggable'):
            lite.check_manifest(BADGING + 'application-debuggable\n', TREE, CONFIG)
        with self.assertRaisesRegex(ValueError, 'test-only'):
            lite.check_manifest(BADGING, TREE.replace('E: application (line=10)', 'E: application (line=10)\n      A: android:testOnly(0x01010272)=(type 0x12)0xffffffff'), CONFIG)

    def test_verification_must_be_present_and_explicitly_false(self):
        for tree in [TREE.replace('ENABLE_VERIFICATION', 'UNRELATED_FLAG'), TREE.replace('android:value(0x01010024)=(type 0x12)0x0', 'android:value(0x01010024)=(type 0x12)0xffffffff'), TREE.replace('android:value(0x01010024)', 'android:resource(0x01010025)')]:
            with self.subTest(tree=tree), self.assertRaisesRegex(ValueError, 'not explicitly disabled'):
                lite.check_manifest(BADGING, tree, CONFIG)

    def test_current_and_legacy_certificate_output_is_accepted(self):
        expected = 'a' * 64
        for label in ['Signer #1', 'V2 Signer:', 'V3 Signer:']:
            with self.subTest(label=label):
                lite.check_certificate(f'Number of signers: 1\n{label} certificate SHA-256 digest: {expected.upper()}\n', expected)
        lite.check_certificate(f'Number of signers: 1\nV2 Signer: certificate SHA-256 digest: {expected}\nV3 Signer: certificate SHA-256 digest: {expected}\n', expected)

    def test_wrong_or_missing_signing_certificate_is_rejected(self):
        for signature in ['Number of signers: 1\n', 'Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ' + 'b' * 64 + '\n']:
            with self.subTest(signature=signature), self.assertRaisesRegex(ValueError, 'differs'):
                lite.check_certificate(signature, 'a' * 64)

    def test_multiple_signers_are_rejected_even_with_the_same_certificate(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            lite.check_certificate('Number of signers: 2\nSigner #1 certificate SHA-256 digest: ' + 'a' * 64 + '\n', 'a' * 64)

    def test_duplicate_verification_flags_are_rejected(self):
        flag = '''      E: meta-data (line=20)
        A: android:name(0x01010003)="art.tsingshui.arxd.ENABLE_VERIFICATION"
        A: android:value(0x01010024)=(type 0x12)0x0
'''
        with self.assertRaisesRegex(ValueError, 'not explicitly disabled'):
            lite.check_manifest(BADGING, TREE + flag, CONFIG)


if __name__ == '__main__':
    unittest.main()
