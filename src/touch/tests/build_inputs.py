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


if __name__ == '__main__':
    unittest.main()
