import concurrent.futures
import os
import pathlib
import subprocess
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
LVGL = ROOT / '.cache/sketchbook/libraries/lvgl'
BUILD = ROOT / '.cache/preview-build'
BUILD.mkdir(parents=True, exist_ok=True)
COMMON = ['-O1', '-DLV_LVGL_H_INCLUDE_SIMPLE', '-I' + str(LVGL), '-I' + str(ROOT / 'preview/include'), '-I' + str(ROOT / 'firmware/touch'), '-DLV_CONF_PATH=' + str(ROOT / 'firmware/lv_conf.h')]
sources = list((LVGL / 'src').rglob('*.c')) + list((ROOT / 'firmware/touch').glob('font_*.c')) + [ROOT / 'firmware/touch/avatar.cpp', ROOT / 'firmware/touch/ui.cpp', ROOT / 'firmware/touch/dm_ui.cpp', ROOT / 'preview/render.cpp']


def compile_source(source):
    target = BUILD / (str(source.relative_to(ROOT)).replace('/', '_') + '.o')
    if not target.exists() or target.stat().st_mtime < max(source.stat().st_mtime, (ROOT / 'firmware/touch/ui.h').stat().st_mtime, (ROOT / 'firmware/lv_conf.h').stat().st_mtime):
        cpp = source.suffix == '.cpp'
        result = subprocess.run(['clang++' if cpp else 'clang', '-std=c++17' if cpp else '-std=c99', *COMMON, '-c', str(source), '-o', str(target)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(str(source) + '\n' + result.stderr)
    return str(target)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    objects = list(pool.map(compile_source, sources))
subprocess.run(['clang++', *objects, '-o', str(BUILD / 'render')], check=True)
output = ROOT / 'build/preview'
output.mkdir(parents=True, exist_ok=True)
photo = Image.open(ROOT.parent / 'web/public/landing/people/lin.webp').convert('RGB').resize((288, 288), Image.Resampling.LANCZOS)
packed = bytearray()
for y in range(288):
    for x in range(288):
        red, green, blue = photo.getpixel((x, y))
        color = (red >> 3) << 11 | (green >> 2) << 5 | blue >> 3
        alpha = 255 if (x - 143.5) ** 2 + (y - 143.5) ** 2 < 142 ** 2 else 0
        packed.extend((color & 255, color >> 8, alpha))
(output / 'photo.bin').write_bytes(packed)
subprocess.run([str(BUILD / 'render'), str(ROOT / 'build/preview')], check=True)
