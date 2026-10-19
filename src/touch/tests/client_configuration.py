import contextlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tools/build.py'
spec = importlib.util.spec_from_file_location('touch_build_configuration', SOURCE)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ClientConfiguration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='alook-touch-client-')
        self.root = pathlib.Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def test_development_build_replaces_previous_private_configuration(self):
        header = build.prepare_client_configuration(self.root, 'artificial-private-value', require_secret=True)
        self.assertIn('artificial-private-value', header.read_text())
        self.assertEqual(build.prepare_client_configuration(self.root), header)
        self.assertNotIn('artificial-private-value', header.read_text())
        self.assertIn('"alook-touch-dev"', header.read_text())
        if os.name != 'nt':
            self.assertEqual(header.stat().st_mode & 0o777, 0o600)

    def test_release_requires_configuration_before_dependency_or_compile_work(self):
        with patch.object(build, 'prepare'), patch.object(build, 'eligible', return_value=True), patch.object(build, 'configure') as configure, patch.dict(os.environ, {'TOUCH_CLIENT_ID': '', 'GITHUB_EVENT_NAME': 'push'}):
            with self.assertRaisesRegex(ValueError, 'requires the TOUCH_CLIENT_ID secret'):
                build.main()
            configure.assert_not_called()

    def test_release_shaped_pull_request_builds_development_without_a_secret(self):
        with patch.object(build, 'ROOT', self.root), patch.object(build, 'prepare'), patch.object(build, 'eligible', return_value=True), patch.object(build, 'configure', side_effect=RuntimeError('fixture stopped before dependencies')) as configure, patch.dict(os.environ, {'TOUCH_CLIENT_ID': '', 'GITHUB_EVENT_NAME': 'pull_request'}):
            with self.assertRaisesRegex(RuntimeError, 'fixture stopped before dependencies'):
                build.main()
            configure.assert_called_once()
        header = self.root / 'firmware/touch/generated/client_id.h'
        self.assertIn('"alook-touch-dev"', header.read_text())

    def test_generated_value_is_escaped_compiles_and_does_not_print(self):
        value = 'fixture-"quoted"-\\value'
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            header = build.prepare_client_configuration(self.root, value, require_secret=True)
        self.assertEqual(output.getvalue(), '')
        self.assertIn(json.dumps(value), header.read_text())
        source = self.root / 'check.cpp'
        source.write_text('#include "firmware/touch/generated/client_id.h"\n#include <string>\nint main() { return std::string(ALOOK_TOUCH_CLIENT_ID) == ' + json.dumps(value) + ' ? 0 : 1; }\n')
        compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
        self.assertTrue(compiler, 'The host contracts require a C++ compiler')
        binary = self.root / 'check'
        subprocess.run([compiler, '-std=c++17', '-Werror', str(source), '-o', str(binary)], check=True, capture_output=True)
        subprocess.run([str(binary)], check=True, capture_output=True)

    def test_invalid_configuration_never_echoes_the_value(self):
        for value in ['value with space', 'line\nbreak', '\x00value', 'x' * 129, '非ASCII']:
            with self.subTest(length=len(value)):
                with self.assertRaises(ValueError) as error:
                    build.prepare_client_configuration(self.root, value)
                self.assertNotIn(value, str(error.exception))


if __name__ == '__main__':
    unittest.main()
