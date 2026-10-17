import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tools/release.py'
spec = importlib.util.spec_from_file_location('touch_release', SOURCE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePackage(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='alook-touch-release-')
        self.repo = pathlib.Path(self.directory.name)
        self.root = self.repo / 'src/touch'
        self.root.mkdir(parents=True)
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.repo / '.gitignore').write_text('src/touch/build/\nsrc/touch/firmware/touch/generated/\n')
        self.commit('initial')

    def tearDown(self):
        self.directory.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True, env=self.env).strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def version(self, version, message):
        (self.root / '.deploy-version').write_text(version + '\n')
        self.commit(message)

    def candidate(self):
        self.version('1.0.0', 'feat: initial Touch version')
        self.version('1.0.1', 'release: v1.0.1')
        self.git('tag', 'v1.0.1')
        info = release.prepare(self.root)
        build = self.root / 'build'
        (build / 'firmware').mkdir(parents=True)
        image = b'\xe9verified fixture bytes'
        (build / 'firmware/touch.ino.bin').write_bytes(image)
        receipt = {'buildInfo': info, 'source_sha256': {'.deploy-version': hashlib.sha256((self.root / '.deploy-version').read_bytes()).hexdigest()}, 'partitions': [
            {'type': 'app', 'subtype': 'ota_0', 'offset': 0x10000, 'size': 0xc80000},
            {'type': 'app', 'subtype': 'ota_1', 'offset': 0xc90000, 'size': 0xc80000}],
            'binary': {'bytes': len(image), 'sha256': hashlib.sha256(image).hexdigest()}}
        (build / 'compile-input.json').write_text(json.dumps(receipt))
        return build, receipt

    def test_first_version_feature_and_unselected_release_do_not_publish(self):
        self.version('1.0.0', 'release: v1.0.0')
        self.assertFalse(release.eligible(self.root))
        self.version('1.0.1', 'feat: version addition')
        self.assertFalse(release.eligible(self.root))
        (self.repo / 'other').write_text('other component')
        self.commit('release: v1.0.2')
        self.assertFalse(release.eligible(self.root))

    def test_only_clean_matching_changed_component_release_is_eligible(self):
        self.version('1.0.0', 'feat: Touch')
        self.version('1.0.1', 'release: v1.0.2')
        self.assertFalse(release.eligible(self.root))
        self.version('1.0.2', 'release: v1.0.2')
        self.assertTrue(release.eligible(self.root))
        (self.repo / 'uncommitted').write_text('changed')
        self.assertFalse(release.eligible(self.root))

    def test_manifest_binds_actual_build_version_source_hardware_and_bytes(self):
        build, receipt = self.candidate()
        manifest = release.stage(self.root)
        self.assertEqual(manifest['version'], receipt['buildInfo']['version'])
        self.assertEqual(manifest['sourceCommit'], self.git('rev-parse', 'HEAD'))
        self.assertEqual(manifest['hardware'], release.HARDWARE)
        self.assertEqual(manifest['partitionLayout'], release.LAYOUT)
        self.assertEqual(release.verify_stage(self.root), manifest)
        header = (self.root / 'firmware/touch/generated/build_info.h').read_text()
        self.assertIn('firmware_version = "1.0.1"', header)
        self.assertIn(manifest['sourceCommit'], header)
        (build / 'release' / manifest['binary']['name']).write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            release.verify_stage(self.root)

    def test_stale_build_receipt_wrong_layout_and_hash_do_not_stage(self):
        build, receipt = self.candidate()
        for field in ['version', 'sourceCommit', 'partitionLayout']:
            bad = copy.deepcopy(receipt)
            bad['buildInfo'][field] = 'wrong'
            (build / 'compile-input.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                release.stage(self.root)
        bad = copy.deepcopy(receipt)
        bad['partitions'][0]['size'] = 0x480000
        (build / 'compile-input.json').write_text(json.dumps(bad))
        with self.assertRaisesRegex(ValueError, 'partition'):
            release.stage(self.root)
        bad = copy.deepcopy(receipt)
        bad['binary']['sha256'] = '0' * 64
        (build / 'compile-input.json').write_text(json.dumps(bad))
        with self.assertRaisesRegex(ValueError, 'binary'):
            release.stage(self.root)

    def test_published_stage_rejects_wrong_tag_and_hardware(self):
        build, _ = self.candidate()
        manifest = release.stage(self.root)
        path = build / 'release/alook-touch-manifest.json'
        bad = copy.deepcopy(manifest)
        bad['hardware'] = 'another board'
        path.write_text(json.dumps(bad))
        with self.assertRaises(ValueError):
            release.verify_stage(self.root)
        path.write_text(json.dumps(manifest))
        self.git('tag', '-f', 'v1.0.1', 'HEAD^')
        with self.assertRaisesRegex(ValueError, 'tag differs'):
            release.verify_stage(self.root)


if __name__ == '__main__':
    unittest.main()
