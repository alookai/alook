import pathlib
import shutil
import struct
import subprocess
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
POSES=[-.9,-.73,-.4,-.03125,0,.05,.117,.5,.91]

class PhotoSampling(unittest.TestCase):
    def test_sharp_photo_retains_one_contour_at_fractional_angles(self):
        harness=r'''
#include "speaker_renderer.h"
#include <array>
#include <cassert>
#include <iostream>
#include <vector>
extern "C" void lv_img_cache_invalidate_src(const void*) {}
int main() {
  std::array<uint8_t,112*112*3> texture{};
  for(int y=0;y<112;++y) for(int c=0;c<3;++c) texture[(y*112+56)*3+c]=255;
  alook_touch::SpeakerRenderer renderer; assert(renderer.set_texture(texture.data()));
  for(float angle:{-.9f,-.73f,-.4f,-.03125f,0.f,.05f,.117f,.5f,.91f}) {
    assert(renderer.render({angle,0,1}));
    std::cout.write(reinterpret_cast<const char*>(renderer.image()->data+233*466*2),466*2);
  }
  renderer.set_reference_palette(); assert(renderer.render({0,0,1}));
  const auto* pixels=reinterpret_cast<const uint16_t*>(renderer.image()->data);
  const auto center=pixels[233*466+233];renderer.finish_frame();
  assert(pixels[0]==0 && pixels[465]==0 && pixels[466*466-1]==0 && pixels[233*466+233]==center);
  std::vector<uint8_t> halo(466*466*3);
  for(int i=0;i<466*466;++i) {halo[i*3]=0xe0;halo[i*3+1]=0x07;halo[i*3+2]=128;}
  lv_img_dsc_t glow{};glow.header.cf=LV_IMG_CF_TRUE_COLOR_ALPHA;glow.header.w=glow.header.h=466;glow.data=halo.data();glow.data_size=halo.size();
  assert(renderer.set_halo(&glow));renderer.set_online(true);assert(renderer.render({0,0,1}));
  assert(pixels[233*466+233]!=center);renderer.finish_frame();assert(pixels[0]==0);
  renderer.set_online(false);assert(renderer.render({0,0,1}));assert(pixels[233*466+233]==center);
}
'''
        with tempfile.TemporaryDirectory(prefix='touch-photo-contours-') as directory:
            base=pathlib.Path(directory);(base/'test.cpp').write_text(harness)
            command=[shutil.which('clang++') or 'g++','-std=c++17','-O2','-I'+str(ROOT/'firmware/touch'),'-I'+str(ROOT/'preview/include'),'-I'+str(ROOT/'.cache/sketchbook/libraries/lvgl'),'-DLV_CONF_PATH='+str(ROOT/'firmware/lv_conf.h'),str(base/'test.cpp'),str(ROOT/'firmware/touch/speaker_renderer.cpp'),'-o',str(base/'test')]
            subprocess.run(command,check=True,capture_output=True)
            result=subprocess.run([str(base/'test')],check=True,capture_output=True).stdout
            self.assertEqual(len(result),len(POSES)*466*2)
            for i,pose in enumerate(POSES):
                row=struct.unpack_from('<466H',result,i*466*2)
                contours=sum((pixel&31)>8 and (x==0 or (row[x-1]&31)<=8) for x,pixel in enumerate(row))
                self.assertEqual(contours,1,f'single photo stripe at yaw{pose}: {contours} contours')

if __name__=='__main__':unittest.main()
