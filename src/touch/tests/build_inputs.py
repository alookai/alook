import hashlib
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tools/build.py'
spec = importlib.util.spec_from_file_location('touch_lvgl_build_inputs', SOURCE)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class LvglBuildInputs(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='alook-touch-lvgl-')
        self.root = pathlib.Path(self.directory.name)
        self.cache = self.root / '.cache'
        self.source = self.root / 'firmware/lv_conf.h'
        self.source.parent.mkdir(parents=True)
        self.source.write_text('#define LV_USE_LARGE_COORD 1\n#define LV_USE_FONT_COMPRESSED 1\n')

    def tearDown(self):
        self.directory.cleanup()

    def test_stale_selected_configuration_is_replaced_from_current_source(self):
        selected = self.cache / 'sketchbook/libraries/lv_conf.h'
        selected.parent.mkdir(parents=True)
        selected.write_text('#define LV_COLOR_DEPTH 16\n')
        neighbor = selected.parent / 'other.h'
        neighbor.write_text('preserve other pinned dependency')
        self.assertEqual(build.prepare_lvgl_configuration(self.root, self.cache), selected)
        self.assertEqual(selected.read_bytes(), self.source.read_bytes())
        self.assertEqual(neighbor.read_text(), 'preserve other pinned dependency')

    def test_missing_source_configuration_never_falls_back_to_stale_cache(self):
        self.source.unlink()
        selected = self.cache / 'sketchbook/libraries/lv_conf.h'
        selected.parent.mkdir(parents=True)
        selected.write_text('stale configuration')
        with self.assertRaises(FileNotFoundError):
            build.prepare_lvgl_configuration(self.root, self.cache)

    def test_configuration_changed_by_the_compiler_cannot_receive_a_bound_receipt(self):
        info = {'version': 'fixture'}
        inputs = {'firmware/lv_conf.h': hashlib.sha256(self.source.read_bytes()).hexdigest()}
        selected = self.cache / 'sketchbook/libraries/lv_conf.h'
        def compile_and_mutate(*_args, **_kwargs):
            selected.write_text('changed during compilation')
            return types.SimpleNamespace(returncode=0)
        with patch.object(build, 'ROOT', self.root), patch.object(build, 'CACHE', self.cache), patch.object(build, 'prepare', return_value=info), patch.object(build, 'eligible', return_value=False), patch.object(build, 'configure'), patch.object(build, 'cli_command', return_value=['fixture-compiler']), patch.object(build, 'source_inputs', return_value=inputs), patch.object(build, 'metadata', return_value=info), patch.object(build.subprocess, 'run', side_effect=compile_and_mutate):
            with self.assertRaisesRegex(SystemExit, 'Selected LVGL configuration changed'):
                build.main()
        self.assertFalse((self.root / 'build/compile-input.json').exists())


class SourceBuildInputs(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='alook-touch-source-')
        self.root = pathlib.Path(self.directory.name)
        self.sketch = self.root / 'firmware/touch'
        for path, content in {
            'dependencies.lock.json': '{}', '.deploy-version': '0.1.54',
            'firmware/lv_conf.h': '#define LV_USE_LARGE_COORD 1\n',
            'tools/build.py': 'fixture builder', 'tools/release.py': 'fixture release',
            'firmware/touch/application.cpp': 'owned source',
            'firmware/touch/partitions.csv': 'owned partition override',
            'firmware/touch/generated/assets.h': 'generated compiler input',
            'firmware/touch/font_cjk.c': 'generated compiler input',
            'firmware/touch/src/codec/build/owned.h': 'legitimate nested source',
        }.items():
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)

    def tearDown(self):
        self.directory.cleanup()

    def run_compiler(self, compiler, current_info=None):
        info = {'version': '0.1.54', 'sourceCommit': 'fixture', 'dirty': True}
        with patch.object(build, 'ROOT', self.root), patch.object(build, 'CACHE', self.root / '.cache'), patch.object(build, 'prepare', return_value=info), patch.object(build, 'eligible', return_value=False), patch.object(build, 'configure'), patch.object(build, 'cli_command', return_value=['fixture-compiler']), patch.object(build, 'metadata', return_value=current_info or info), patch.object(build.subprocess, 'run', side_effect=compiler):
            build.main()

    def test_native_sketch_build_exports_never_change_source_inputs(self):
        with patch.object(build, 'ROOT', self.root):
            before = build.source_inputs()
            for path in ['build/esp32.esp32.esp32s3/partitions.csv', 'build/exported.cpp', 'build/exported.h']:
                output = self.sketch / path
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text('native output')
            self.assertEqual(build.source_inputs(), before)
            (self.sketch / 'build/esp32.esp32.esp32s3/partitions.csv').write_text('new native output')
            self.assertEqual(build.source_inputs(), before)

    def test_real_partition_generated_sources_and_nested_source_remain_bound(self):
        with patch.object(build, 'ROOT', self.root):
            for path in ['partitions.csv', 'generated/assets.h', 'font_cjk.c', 'src/codec/build/owned.h']:
                with self.subTest(path=path):
                    before = build.source_inputs()
                    relative = 'firmware/touch/' + path
                    self.assertIn(relative, before)
                    (self.sketch / path).write_text('changed real input')
                    self.assertNotEqual(build.source_inputs()[relative], before[relative])

    def test_main_rejects_added_removed_or_modified_real_source_with_names(self):
        application = self.sketch / 'application.cpp'
        added = self.sketch / 'new.h'
        for action in ['added', 'removed', 'changed']:
            with self.subTest(action=action):
                application.write_text('owned source')
                if added.exists():
                    added.unlink()
                def compile_and_mutate(*_args, **_kwargs):
                    if action == 'added':
                        added.write_text('new source')
                    elif action == 'removed':
                        application.unlink()
                    else:
                        application.write_text('mutated source')
                    return types.SimpleNamespace(returncode=0)
                name = 'new.h' if action == 'added' else 'application.cpp'
                with self.assertRaisesRegex(SystemExit, 'Firmware source inputs changed.*' + name):
                    self.run_compiler(compile_and_mutate)
                self.assertFalse((self.root / 'build/compile-input.json').exists())

    def test_main_rejects_build_identity_change_separately(self):
        def compile_success(*_args, **_kwargs):
            return types.SimpleNamespace(returncode=0)
        with self.assertRaisesRegex(SystemExit, 'Firmware build identity changed.*sourceCommit'):
            self.run_compiler(compile_success, {'version': '0.1.54', 'sourceCommit': 'changed', 'dirty': True})
        self.assertFalse((self.root / 'build/compile-input.json').exists())


if __name__ == '__main__':
    unittest.main()
