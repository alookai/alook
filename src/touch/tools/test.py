import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('Set CXX to a C++17 compiler')
with tempfile.TemporaryDirectory(prefix='alook-touch-host-') as directory:
    for source in sorted((ROOT / 'tests').glob('*.cpp')):
        binary = pathlib.Path(directory) / source.stem
        subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I' + str(ROOT / '.cache/sketchbook/libraries/ArduinoJson-7.4.3/src'), str(source), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
