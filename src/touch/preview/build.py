import concurrent.futures
import os
import pathlib
import subprocess
import sys
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
LVGL = ROOT / '.cache/sketchbook/libraries/lvgl'
BUILD = ROOT / '.cache/preview-build'
BUILD.mkdir(parents=True, exist_ok=True)
COMMON = ['-O1', '-DLV_LVGL_H_INCLUDE_SIMPLE', '-I' + str(LVGL), '-I' + str(ROOT / 'preview/include'), '-I' + str(ROOT / 'firmware/touch'), '-DLV_CONF_PATH=' + str(ROOT / 'firmware/lv_conf.h')]
sys.path.insert(0, str(ROOT / 'tests'))
from display_frame_test import function
board_source = (ROOT / 'firmware/touch/board.cpp').read_text()
frame_source = BUILD / 'native_frame.cpp'
frame_source.write_text(r'''#include "native_frame.h"
#include <algorithm>
#include <cassert>
constexpr int LCD_WIDTH=466, LCD_HEIGHT=466;
#include <cstring>
int preview_panel_calls=0, preview_panel_y=-1, preview_panel_height=-1;
namespace {
int dirty_top=LCD_HEIGHT, dirty_bottom=-1;
struct Display {
  lv_color_t* target=nullptr;
  bool draw16bitRGBBitmap(int x,int y,const uint16_t* source,int width,int height) {
    assert(x==0 && y>=0 && width==466 && height>0 && y+height<=466);
    ++preview_panel_calls; preview_panel_y=y; preview_panel_height=height;
    for(int row=0;row<height;++row) for(int col=0;col<width;++col) target[(y+row)*466+col].full=source[row*width+col];
    return true;
  }
} display;
void usb_mirror_flush(const lv_area_t*,const lv_color_t*) {}
''' + function(board_source, 'void flush(') + '\n' + function(board_source, 'bool board_present(') + r'''
}
void preview_board_flush(lv_disp_drv_t* driver,const lv_area_t* area,lv_color_t* source,lv_color_t* panel) {
  display.target=panel; flush(driver,area,source);
}
bool preview_board_present(const lv_img_dsc_t* frame,lv_color_t* panel) {
  display.target=panel;return board_present(frame);
}
''')
sources = list((LVGL / 'src').rglob('*.c')) + list((ROOT / 'firmware/touch').glob('font_*.c')) + [ROOT / 'firmware/touch/speaker_renderer.cpp', ROOT / 'firmware/touch/avatar.cpp', ROOT / 'firmware/touch/ui.cpp', ROOT / 'firmware/touch/dm_ui.cpp', ROOT / 'preview/render.cpp', frame_source]


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
