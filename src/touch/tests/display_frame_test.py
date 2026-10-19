import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def function(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


class DisplayFrameTest(unittest.TestCase):
    def execute(self, body):
        source = (ROOT / 'firmware/touch/board.cpp').read_text()
        compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        prefix = r'''
#include <array>
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdlib>
constexpr int LCD_WIDTH = 466, LCD_HEIGHT = 466;
enum { MALLOC_CAP_DMA = 1, MALLOC_CAP_INTERNAL = 2, MALLOC_CAP_SPIRAM = 4, MALLOC_CAP_8BIT = 8 };
struct lv_color_t { uint16_t full = 0; };
enum { LV_IMG_CF_TRUE_COLOR=1, LV_IMG_CF_TRUE_COLOR_ALPHA=2 };
struct lv_img_dsc_t { struct { int cf=0,w=0,h=0; } header; uint32_t data_size=0; const uint8_t* data=nullptr; };
struct lv_area_t { int x1, y1, x2, y2; };
struct lv_disp_draw_buf_t { size_t size = 0; void* first = nullptr; void* second = nullptr; };
struct lv_draw_ctx_t { const lv_area_t* clip_area = nullptr; };
struct lv_disp_drv_t {
  lv_draw_ctx_t* draw_ctx = nullptr;
  int hor_res = 0, ver_res = 0, direct_mode = 0;
  bool last = false;
  int acknowledged = 0;
  lv_disp_draw_buf_t* draw_buf = nullptr;
  void (*flush_cb)(lv_disp_drv_t*, const lv_area_t*, lv_color_t*) = nullptr;
  void (*rounder_cb)(lv_disp_drv_t*, lv_area_t*) = nullptr;
};
struct Display {
  int calls = 0, last_y = -1, last_height = -1;
  std::array<uint16_t, LCD_WIDTH * LCD_HEIGHT> image{};
  bool draw16bitRGBBitmap(int x, int y, const uint16_t* pixels, int width, int height) {
    ++calls; last_y = y; last_height = height;
    assert(x == 0 && y >= 0 && width == LCD_WIDTH && height > 0 && y + height <= LCD_HEIGHT);
    std::copy(pixels, pixels + width * height, image.begin() + y * width);
    return true;
  }
} display;
int dirty_top = LCD_HEIGHT, dirty_bottom = -1;
int mirrored = 0;
std::array<uint16_t, LCD_WIDTH * LCD_HEIGHT> mirror{};
void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels) {
  ++mirrored;
  assert(area->x1 == 0 && area->y1 == 0 && area->x2 == LCD_WIDTH - 1 && area->y2 == LCD_HEIGHT - 1);
  for (size_t i = 0; i < mirror.size(); ++i) mirror[i] = pixels[i].full;
}
bool lv_disp_flush_is_last(lv_disp_drv_t* driver) { return driver->last; }
void lv_disp_flush_ready(lv_disp_drv_t* driver) { ++driver->acknowledged; }
size_t allocated = 0;
int allocation_flags = 0;
void* heap_caps_malloc(size_t size, int flags) {
  allocated = size; allocation_flags = flags;
  return std::calloc(1, size);
}
void lv_disp_draw_buf_init(lv_disp_draw_buf_t* buffer, void* first, void* second, size_t size) {
  *buffer = {size, first, second};
}
void lv_disp_drv_init(lv_disp_drv_t* driver) { *driver = {}; }
lv_disp_drv_t registered;
void lv_disp_drv_register(lv_disp_drv_t* driver) { registered = *driver; }
'''
        functions = function(source, 'void round_area(') + '\n' + function(source, 'void flush(') + '\n' + function(source, 'bool board_present(')
        setup_start = source.index('  constexpr size_t pixel_count =')
        setup_end = source.index('  lv_disp_drv_register(&driver);', setup_start) + len('  lv_disp_drv_register(&driver);')
        setup = source[setup_start:setup_end]
        program = prefix + functions + '\nbool configure() {\n' + setup + '\nreturn true;\n}\nint main() {\n' + body + '\n}\n'
        with tempfile.TemporaryDirectory(prefix='alook-touch-frame-') as directory:
            path = pathlib.Path(directory)
            (path / 'test.cpp').write_text(program)
            built = subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', str(path / 'test.cpp'), '-o', str(path / 'test')], capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(path / 'test')], capture_output=True, text=True)
            self.assertEqual(ran.returncode, 0, ran.stderr)

    def test_partial_refresh_publishes_one_completed_band(self):
        self.execute(r'''
  std::array<lv_color_t, LCD_WIDTH * LCD_HEIGHT> frame{};
  for (size_t i = 0; i < frame.size() / 2; ++i) frame[i].full = 0x1122;
  lv_disp_drv_t driver;
  const lv_area_t first = {0, 0, LCD_WIDTH - 1, LCD_HEIGHT / 2 - 1};
  flush(&driver, &first, frame.data());
  assert(display.calls == 0 && mirrored == 0 && driver.acknowledged == 1);
  for (size_t i = frame.size() / 2; i < frame.size(); ++i) frame[i].full = 0x3344;
  driver.last = true;
  const lv_area_t last = {0, LCD_HEIGHT / 2, LCD_WIDTH - 1, LCD_HEIGHT - 1};
  flush(&driver, &last, frame.data());
  assert(display.calls == 1 && mirrored == 1 && driver.acknowledged == 2);
  for (size_t i = 0; i < frame.size(); ++i) {
    assert(display.image[i] == frame[i].full && mirror[i] == frame[i].full);
  }
  frame[14 * LCD_WIDTH + 12].full = 0x7788;
  const lv_area_t small = {12, 14, 13, 15};
  flush(&driver, &small, frame.data());
  assert(display.calls == 2 && mirrored == 2 && driver.acknowledged == 3);
  assert(display.image[14 * LCD_WIDTH + 12] == 0x7788);
  assert(display.image[0] == 0x1122 && display.image.back() == 0x3344);
  const lv_area_t full = {0, 0, LCD_WIDTH - 1, LCD_HEIGHT - 1};
  lv_draw_ctx_t context{&small}; driver.draw_ctx = &context;
  frame[0].full = 0xdead; frame[14 * LCD_WIDTH + 12].full = 0xaabb;
  flush(&driver, &full, frame.data());
  assert(display.calls == 3 && display.last_y == 14 && display.last_height == 2);
  assert(display.image[0] == 0x1122 && display.image[14 * LCD_WIDTH + 12] == 0xaabb);
  assert(mirror[0] == 0xdead);

''')

    def test_native_registration_uses_one_complete_direct_buffer(self):
        self.execute(r'''
  assert(configure());
  assert(registered.hor_res == LCD_WIDTH && registered.ver_res == LCD_HEIGHT);
  assert(registered.direct_mode == 1);
  assert(registered.draw_buf && registered.draw_buf->size == size_t(LCD_WIDTH * LCD_HEIGHT));
  assert(registered.draw_buf->first && registered.draw_buf->second == nullptr);
  assert(allocated == sizeof(lv_color_t) * LCD_WIDTH * LCD_HEIGHT);
  assert(allocation_flags == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  assert(registered.flush_cb == flush && registered.rounder_cb == round_area);
  std::free(registered.draw_buf->first);
''')

    def test_direct_completed_frame_validation_and_transfer(self):
        self.execute(r"""
  std::array<lv_color_t,LCD_WIDTH*LCD_HEIGHT> frame{};
  for(size_t i=0;i<frame.size();++i) frame[i].full=static_cast<uint16_t>(i*37);
  lv_img_dsc_t image;
  image.header={LV_IMG_CF_TRUE_COLOR,LCD_WIDTH,LCD_HEIGHT};
  image.data=reinterpret_cast<const uint8_t*>(frame.data());image.data_size=sizeof(frame);
  assert(!board_present(nullptr));
  auto invalid=image;invalid.data=nullptr;assert(!board_present(&invalid));
  invalid=image;invalid.header.cf=LV_IMG_CF_TRUE_COLOR_ALPHA;assert(!board_present(&invalid));
  invalid=image;invalid.header.w=232;assert(!board_present(&invalid));
  invalid=image;invalid.data_size-=2;assert(!board_present(&invalid));
  assert(display.calls==0 && mirrored==0);
  assert(board_present(&image));assert(display.calls==1 && mirrored==1);
  for(size_t i=0;i<frame.size();++i) assert(display.image[i]==frame[i].full && mirror[i]==frame[i].full);
""")


if __name__ == '__main__':
    unittest.main()
