import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
POSES = [-1, -.73, -.4, -.03125, 0, .117, .5, .91, 1]

class SpeakerPipeline(unittest.TestCase):
    def test_actual_reference_frames_interpolation_and_upscale_match(self):
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        common = r'''
#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
constexpr double PI = 3.1415926535897932384626433832795;
constexpr int W=466,H=466,CX=233,CY=233,RADIUS=233;
const float poses[]={-1,-.73f,-.4f,-.03125f,0,.117f,.5f,.91f,1};
'''
        reference = common + r'''
using std::min; using std::max;
struct AvatarDef { float hue=0,sat=1; };
AvatarDef g_buddyCustomDef, AVATARS[1]; bool g_buddyCustom=false; int g_avatarIdx=0;
void rgb2hsl(float,float,float,float*,float*,float*) { assert(false); }
void hsl2rgb(float,float,float,float*,float*,float*) { assert(false); }
float constrain(float value,float low,float high) { return std::clamp(value,low,high); }
float frand(float,float) { static int index=0; return ((index++ *37+13)&7); }
uint32_t irDirtyMask=0;
float g_lookFreeze=0,g_sphereScale=1,currentPose=0; int g_sphereYOff=0;
struct Canvas { std::array<uint16_t,W*H> data{}; uint16_t* getFramebuffer() { return data.data(); } } storage;
Canvas* canvas=&storage;
void getIdle(float,float* x,float* y,float* eyes) { *x=currentPose;*y=0;*eyes=1; }
void drawIdleFaceLook(int,int,float,float,float,float,float) {}
#include "reference/speaker_idle.h"
int main() {
  irInit();
  for(int i=0;i<IR_FRAMES;++i) { irGenFrame(i); std::cout.write(reinterpret_cast<const char*>(irFrames[i]),IR_SPR*IR_SPR*3); }
  for(float x:poses) { currentPose=x; animIdleRainbow(0);std::cout.write(reinterpret_cast<const char*>(canvas->getFramebuffer()),W*H*2); }
}
'''
        port = common + r'''
#include "speaker_renderer.h"
extern "C" void lv_img_cache_invalidate_src(const void*) {}
int main() {
  alook_touch::SpeakerRenderer renderer; renderer.set_reference_palette();
  int8_t noise[256];for(int i=0;i<256;++i) noise[i]=(i*37+13)&7; renderer.set_noise(noise);
  for(int i=0;i<11;++i) std::cout.write(reinterpret_cast<const char*>(renderer.frame(i)),112*112*3);
  for(float x:poses) { assert(renderer.render({x,0,1}));const auto* image=renderer.image();std::cout.write(reinterpret_cast<const char*>(image->data),image->data_size); }
}
'''
        with tempfile.TemporaryDirectory(prefix='touch-speaker-reference-') as directory:
            directory = pathlib.Path(directory)
            outputs=[]
            for name, body in [('reference', reference), ('port', port)]:
                source=directory/(name+'.cpp'); source.write_text(body)
                command=[compiler,'-std=c++17','-O1','-ffp-contract=off','-I'+str(ROOT/'tests'),'-I'+str(ROOT/'firmware/touch'),'-I'+str(ROOT/'preview/include'),'-I'+str(ROOT/'.cache/sketchbook/libraries/lvgl'),'-DLV_CONF_PATH='+str(ROOT/'firmware/lv_conf.h'),str(source)]
                if name=='port': command.append(str(ROOT/'firmware/touch/speaker_renderer.cpp'))
                binary=directory/name
                subprocess.run(command+['-o',str(binary)],check=True,capture_output=True)
                outputs.append(subprocess.run([str(binary)],check=True,capture_output=True).stdout)
            self.assertEqual(len(outputs[0]),11*112*112*3+len(POSES)*466*466*2)
            for index in range(11):
                start=index*112*112*3;end=start+112*112*3
                self.assertEqual(outputs[0][start:end],outputs[1][start:end],f'reference rotation frame {index}')
            for index,pose in enumerate(POSES):
                start=11*112*112*3+index*466*466*2;end=start+466*466*2
                self.assertEqual(outputs[0][start:end],outputs[1][start:end],f'reference interpolation/upscale pose {pose}')

if __name__=='__main__': unittest.main()
