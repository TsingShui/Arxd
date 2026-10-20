"""Transport unit tests only; not Android runtime acceptance."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_packages', Path(__file__).resolve().parents[1] / 'scripts/runtime-packages.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'test.deb'
        self.data = b'fixture, not a real package'
        self.package = {'Filename': 'pool/test.deb', 'Size': str(len(self.data)), 'SHA256': runtime.sha(self.data)}

    def download(self, args, **kwargs):
        self.assertTrue(kwargs['check'])
        self.assertIn('--connect-timeout', args)
        self.assertIn('--max-time', args)
        self.assertIn('--speed-time', args)
        Path(args[-1]).write_bytes(self.data)

    def test_primary_success_verifies_and_promotes_download(self):
        with patch.object(runtime.subprocess, 'run', side_effect=self.download) as run:
            runtime.download_package(self.package, self.path)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.path.read_bytes(), self.data)
        self.assertFalse(self.path.with_suffix('.download').exists())

    def test_transport_failure_uses_official_fallback(self):
        def fetch(args, **kwargs):
            if args[-3].startswith(runtime.URL):
                Path(args[-1]).write_bytes(b'partial')
                raise subprocess.CalledProcessError(22, args)
            self.assertEqual(args[-3], 'https://packages.termux.dev/apt/termux-main/pool/test.deb')
            self.download(args, **kwargs)
        with patch.object(runtime.subprocess, 'run', side_effect=fetch) as run:
            runtime.download_package(self.package, self.path)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_hash_or_size_mismatch_fails_closed_without_fallback(self):
        for change in ({'SHA256': '0' * 64}, {'Size': '1'}):
            with self.subTest(change=change), patch.object(runtime.subprocess, 'run', side_effect=self.download) as run:
                with self.assertRaises(AssertionError):
                    runtime.download_package(self.package | change, self.path)
                self.assertEqual(run.call_count, 1)
                self.assertFalse(self.path.exists())
                self.assertFalse(self.path.with_suffix('.download').exists())

    def test_both_endpoints_failing_does_not_leave_partial_download(self):
        with patch.object(runtime.subprocess, 'run', side_effect=subprocess.CalledProcessError(28, 'curl')) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                runtime.download_package(self.package, self.path)
        self.assertEqual(run.call_count, 2)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.path.with_suffix('.download').exists())


if __name__ == '__main__':
    unittest.main()
