import pathlib
import shutil
import subprocess
import tempfile
import unittest

from display_frame_test import function

ROOT = pathlib.Path(__file__).resolve().parents[1]


class DrawProfileTest(unittest.TestCase):
    def test_vendor_callback_is_forwarded_once_for_all_paths(self):
        source = (ROOT / 'firmware/touch/board.cpp').read_text()
        body = r'''
#include <cassert>
#include <cstdint>
struct lv_area_t { int x1, y1, x2, y2; };
struct lv_draw_ctx_t { const lv_area_t* clip_area; };
struct lv_draw_img_dsc_t { int angle, zoom, recolor_opa, opa; };
enum lv_img_cf_t { LV_IMG_CF_TRUE_COLOR, LV_IMG_CF_TRUE_COLOR_ALPHA };
constexpr int LV_IMG_ZOOM_NONE=256, LV_OPA_TRANSP=0, LV_OPA_MAX=253;
bool masked=false;
bool lv_draw_mask_is_any(const lv_area_t*) { return masked; }
uint32_t now=100;
uint32_t usb_mirror_micros() { return now; }
uint32_t image_draw_us=0, image_draw_calls=0, image_fast_calls=0;
int forwarded=0;
lv_draw_ctx_t* expected_context;
const lv_draw_img_dsc_t* expected_descriptor;
const lv_area_t* expected_coordinates;
const uint8_t* expected_source;
lv_img_cf_t expected_format;
void vendor(lv_draw_ctx_t* c,const lv_draw_img_dsc_t* d,const lv_area_t* a,const uint8_t* s,lv_img_cf_t f) {
  assert(c==expected_context && d==expected_descriptor && a==expected_coordinates && s==expected_source && f==expected_format);
  ++forwarded;now+=17;
}
void (*software_image)(lv_draw_ctx_t*,const lv_draw_img_dsc_t*,const lv_area_t*,const uint8_t*,lv_img_cf_t)=vendor;
'''
        body += function(source, 'void profile_image(')
        body += r'''
int main() {
 lv_area_t area{0,0,465,465};lv_draw_ctx_t context{&area};
 lv_draw_img_dsc_t descriptor{0,256,0,255};uint8_t pixel=0;
 expected_context=&context;expected_descriptor=&descriptor;expected_coordinates=&area;expected_source=&pixel;
 for(int n=0;n<5;++n) {
  expected_format=n==1?LV_IMG_CF_TRUE_COLOR_ALPHA:LV_IMG_CF_TRUE_COLOR;
  descriptor.zoom=n==2?512:256;descriptor.opa=n==3?128:255;masked=n==4;
  profile_image(&context,&descriptor,&area,&pixel,expected_format);
  assert(forwarded==n+1 && image_draw_calls==uint32_t(n+1) && image_draw_us==uint32_t((n+1)*17));
 }
 assert(image_fast_calls==1);
}
'''
        with tempfile.TemporaryDirectory(prefix='touch-draw-profile-') as directory:
            path = pathlib.Path(directory)
            (path / 'test.cpp').write_text(body)
            subprocess.run([shutil.which('clang++') or 'g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True, capture_output=True)
            subprocess.run([str(path / 'test')], check=True, capture_output=True)
