import hashlib
import itertools
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
WORKSPACES = ['shared', 'app', 'daemon', 'daemon/agent-driver', 'web', 'email-worker', 'ws-do', 'queue-worker', 'desktop']


def command(root, *args):
    return subprocess.run(args, cwd=root, capture_output=True, text=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})


class VersionBump(unittest.TestCase):
    def fixture(self, directory):
        root = pathlib.Path(directory)
        (root / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/bump-version.mjs', root / 'scripts/bump-version.mjs')
        for workspace in WORKSPACES:
            path = root / 'src' / workspace
            path.mkdir(parents=True, exist_ok=True)
            (path / 'package.json').write_text(json.dumps({'name': workspace, 'version': '0.1.54'}))
        for name in ['touch/.deploy-version', 'desktop/.deploy-version', 'desktop/.deploy-version-mobile']:
            path = root / 'src' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('0.1.54\n')
        native = root / 'src/desktop/src-tauri'
        (native / 'gen/apple').mkdir(parents=True)
        (native / 'tauri.conf.json').write_text('{"version":"0.1.54"}')
        (native / 'Cargo.toml').write_text('[package]\nname = "alook-desktop"\nversion = "0.1.54"\n')
        (native / 'Cargo.lock').write_text('[[package]]\nname = "alook-desktop"\nversion = "0.1.54"\n')
        (native / 'gen/apple/project.yml').write_text('settings:\n  CFBundleShortVersionString: 0.1.54\n')
        (root / 'src/web/wrangler.toml').write_text('MIN_CLI_VERSION = "0.1.54"\n')
        for args in [('git', 'init', '-q'), ('git', 'config', 'user.name', 'Touch fixture'), ('git', 'config', 'user.email', 'touch@fixture.invalid'), ('git', 'add', '.'), ('git', 'commit', '-qm', 'fixture')]:
            result = command(root, *args)
            self.assertEqual(result.returncode, 0, result.stderr)
        return root

    def test_each_component_combination_runs_the_real_script_in_an_isolated_repo(self):
        for selected in itertools.product([False, True], repeat=3):
            with self.subTest(selected=selected), tempfile.TemporaryDirectory(prefix='touch-version-') as directory:
                root = self.fixture(directory)
                flags = [flag for flag, included in zip(['--desktop', '--mobile', '--touch'], selected) if included]
                result = command(root, 'node', 'scripts/bump-version.mjs', 'patch', *flags)
                self.assertEqual(result.returncode, 0, result.stderr)
                for name, included in zip(['desktop/.deploy-version', 'desktop/.deploy-version-mobile', 'touch/.deploy-version'], selected):
                    self.assertEqual((root / 'src' / name).read_text(), '0.1.55\n' if included else '0.1.54\n')
                for workspace in WORKSPACES:
                    self.assertEqual(json.loads((root / 'src' / workspace / 'package.json').read_text())['version'], '0.1.55')
                changed = command(root, 'git', 'show', '--pretty=', '--name-only', 'HEAD').stdout.splitlines()
                self.assertEqual('src/touch/.deploy-version' in changed, selected[2])
                self.assertEqual(command(root, 'git', 'log', '-1', '--pretty=%s').stdout.strip(), 'release: v0.1.55')
                self.assertEqual(command(root, 'git', 'status', '--porcelain').stdout, '')

    def test_help_invalid_flags_and_explicit_version(self):
        with tempfile.TemporaryDirectory(prefix='touch-version-') as directory:
            root = self.fixture(directory)
            help_result = command(root, 'node', 'scripts/bump-version.mjs')
            self.assertNotEqual(help_result.returncode, 0)
            self.assertIn('--touch', help_result.stderr)
            bad = command(root, 'node', 'scripts/bump-version.mjs', 'patch', '--touches')
            self.assertNotEqual(bad.returncode, 0)
            self.assertEqual(command(root, 'git', 'status', '--porcelain').stdout, '')
            result = command(root, 'node', 'scripts/bump-version.mjs', 'v1.2.3', '--touch', '--min-cli')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / 'src/touch/.deploy-version').read_text(), '1.2.3\n')
            self.assertIn('MIN_CLI_VERSION = "1.2.3"', (root / 'src/web/wrangler.toml').read_text())


if __name__ == '__main__':
    index = pathlib.Path(command(ROOT, 'git', 'rev-parse', '--git-path', 'index').stdout.strip())
    if not index.is_absolute():
        index = ROOT / index
    version = ROOT / 'src/touch/.deploy-version'
    protected = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in [index, version]}
    result = unittest.main(exit=False)
    for path, expected in protected.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit('Isolated version tests changed a protected real-worktree input')
    if not result.result.wasSuccessful():
        raise SystemExit(1)
