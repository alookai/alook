import pathlib
import shutil
import subprocess
import tempfile
import unittest


class ImageAsset(unittest.TestCase):
    def test_actual_decoder_assets_and_sphere_frames_retire_without_worker_lvgl(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        body = (root / 'firmware/touch/image_art.cpp').read_text()
        body = '\n'.join(line for line in body.splitlines() if not line.startswith('#include'))
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'lvgl.h').write_text(r'''
#pragma once
#include <cstdint>
struct lv_img_header_t { int cf=0, w=0, h=0; };
struct lv_img_dsc_t { lv_img_header_t header; const uint8_t* data=nullptr; uint32_t data_size=0; };
constexpr int LV_IMG_CF_TRUE_COLOR_ALPHA=1, LV_IMG_CF_TRUE_COLOR=2;
inline int invalidations=0;
inline void lv_img_cache_invalidate_src(const void*) { ++invalidations; }
''')
            (base / 'image_art.h').write_text((root / 'firmware/touch/image_art.h').read_text())
            harness = r'''
#include "image_art.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <cassert>
#include <iostream>
#define ALOOK_TOUCH_USB_MIRROR 0
constexpr int MALLOC_CAP_SPIRAM=0, MALLOC_CAP_8BIT=0;
size_t live_allocations=0;
bool fail_frames=false;
void* heap_caps_malloc(size_t size,int) { if(fail_frames && size==466*466*3+112*112*3) return nullptr; auto* p=malloc(size); if(p) ++live_allocations; return p; }
void heap_caps_free(void* p) { if(p) --live_allocations; free(p); }
struct WebPAnimDecoder {};
struct WebPData { const uint8_t* data; size_t size; };
struct WebPAnimDecoderOptions { int color_mode; };
struct WebPBitstreamFeatures { int width,height,has_animation; };
constexpr int VP8_STATUS_OK=0, MODE_RGBA=0, STBIR_RGBA=0;
int WebPGetFeatures(const uint8_t*,size_t,WebPBitstreamFeatures*) { return 1; }
bool WebPAnimDecoderOptionsInit(WebPAnimDecoderOptions*) { return false; }
WebPAnimDecoder* WebPAnimDecoderNew(WebPData*,WebPAnimDecoderOptions*) { return nullptr; }
bool WebPAnimDecoderGetNext(WebPAnimDecoder*,uint8_t**,int*) { return false; }
void WebPAnimDecoderDelete(WebPAnimDecoder*) {}
uint8_t* WebPDecodeRGBA(const uint8_t*,size_t,int*,int*) { return nullptr; }
void WebPFree(void* p) { free(p); }
bool stbi_info_from_memory(const uint8_t* p,size_t,int* w,int* h,int*) { *w=*h=16; return *p=='v'; }
uint8_t* stbi_load_from_memory(const uint8_t*,size_t,int*,int*,int*,int) { return static_cast<uint8_t*>(malloc(16*16*4)); }
void stbi_image_free(void* p) { free(p); }
bool stbir_resize_uint8_linear(const uint8_t*,int,int,int,uint8_t* output,int w,int h,int,int) {
  for(int y=0;y<h;++y) for(int x=0;x<w;++x) { auto* p=output+(y*w+x)*4; p[0]=x*255/w; p[1]=y*255/h; p[2]=64; p[3]=255; } return true;
}
'''
            harness += body
            harness += r'''
int main() {
  using namespace alook_touch;
  assert(!decode_image("")); assert(!decode_image("bad"));
  assert(!decode_image(std::string(512*1024+1,'v')));
  auto plain=decode_image("valid");
  assert(plain && plain->image.header.w==466 && !plain->texture);
  assert(plain->pixels[2]==0 && plain->pixels[(233*466+233)*3+2]==255);
  plain.reset(); assert(live_allocations==0 && invalidations==0);
  auto sphere=decode_image("valid",true);
  assert(sphere && sphere->image.header.cf==LV_IMG_CF_TRUE_COLOR_ALPHA);
  assert(sphere->texture==sphere->pixels+466*466*3);
  assert(sphere->texture[0]<sphere->texture[56*3]);
  assert(sphere->texture[56*3]<sphere->texture[111*3]);
  assert(invalidations==0 && live_allocations==1);
  ImageArt ui;
  ui.set(sphere); ui.set(sphere); assert(invalidations==0);
  assert(ui.texture()==sphere->texture);
  auto stale=sphere; sphere.reset(); ui.clear();
  assert(invalidations==1 && live_allocations==1);
  stale.reset(); assert(live_allocations==0 && invalidations==1);
  fail_frames=true;
  auto fallback=decode_image("valid",true);
  assert(!fallback && live_allocations==0 && invalidations==1);
  std::cout << "Native decoder asset ownership, sphere direction and memory fallback passed\n";
}
'''
            (base / 'test.cpp').write_text(harness)
            binary = base / 'test'
            subprocess.run([compiler, '-std=c++17', '-O1', '-I'+str(base), str(base/'test.cpp'), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
