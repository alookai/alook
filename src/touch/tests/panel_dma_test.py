import pathlib
import shutil
import subprocess
import tempfile
import unittest
from display_frame_test import function

ROOT=pathlib.Path(__file__).resolve().parents[1]

class PanelDmaOwnership(unittest.TestCase):
    def test_actual_swap_and_queue_never_reuse_live_dma_buffers(self):
        source=(ROOT/'firmware/touch/panel_dma.cpp').read_text()
        code=r'''
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <deque>
#include <vector>
constexpr int ESP_OK=0,portMAX_DELAY=-1;
class PanelDma {
public:
  static constexpr int chunk_pixels=16380;
  alignas(4) uint16_t memory_[2][chunk_pixels]{};
  uint16_t* ping_[2]={memory_[0],memory_[1]};
  uint32_t buffer_sequence_[2]{},queued_=0;
  std::atomic<uint32_t> done_{0};
  int panel_=1,completion_=1;
  void wait_until(uint32_t sequence);
  void wait();
  static void swap_copy(uint16_t*,const uint16_t*,size_t);
  bool draw16bitRGBBitmap(int,int,const uint16_t*,int,int);
};
struct Pending { const uint16_t* pointer;std::vector<uint16_t> expected; };
std::deque<Pending> pending;
std::vector<std::vector<uint16_t>> completed;
PanelDma* active=nullptr;
int calls=0,fail_at=-1;
void finish_one() {
  assert(!pending.empty()); auto entry=pending.front();pending.pop_front();
  assert(std::equal(entry.expected.begin(),entry.expected.end(),entry.pointer));
  completed.push_back(entry.expected);active->done_.fetch_add(1);
}
void xSemaphoreTake(int,int) { finish_one(); }
int esp_lcd_panel_draw_bitmap(int,int x,int y,int xe,int ye,const uint16_t* pointer) {
  assert(x>=0 && y>=0 && xe>x && ye>y);
  assert(((x|y|xe|ye)&1)==0);
  ++calls;if(calls==fail_at) return -1;
  while(!pending.empty()) finish_one();
  const int count=(xe-x)*(ye-y);
  assert(count<=16380);
  pending.push_back({pointer,std::vector<uint16_t>(pointer,pointer+count)});
  return ESP_OK;
}
'''
        for signature in ['void PanelDma::wait_until(', 'void PanelDma::wait()', 'void PanelDma::swap_copy(', 'bool PanelDma::draw16bitRGBBitmap(']:
            code+=function(source,signature)+'\n'
        code+=r'''
int main() {
  alignas(4) uint16_t input[]={0x1234,0xabcd,0xf800,0x07e0,0x001f};
  alignas(4) uint16_t swapped[5]{};
  PanelDma::swap_copy(swapped,input,5);
  for(int i=0;i<5;++i) assert(swapped[i]==__builtin_bswap16(input[i]));
  PanelDma::swap_copy(swapped,input+1,3);
  for(int i=0;i<3;++i) assert(swapped[i]==__builtin_bswap16(input[i+1]));
  PanelDma panel;active=&panel;
  std::vector<uint16_t> pixels(466*466);
  for(size_t i=0;i<pixels.size();++i) pixels[i]=(i*31)^0x3141;
  assert(panel.draw16bitRGBBitmap(0,0,pixels.data(),466,466));
  assert(!pending.empty() && panel.done_.load()<panel.queued_);
  std::fill(pixels.begin(),pixels.end(),0xaaaa);
  assert(panel.draw16bitRGBBitmap(0,0,pixels.data(),466,466));
  panel.wait();assert(pending.empty() && panel.done_==panel.queued_);
  assert(calls==28 && completed.size()==28);
  for(int chunk=14;chunk<28;++chunk) for(auto value:completed[chunk]) assert(value==0xaaaa);
  fail_at=calls+3;
  assert(!panel.draw16bitRGBBitmap(0,0,pixels.data(),466,466));
  assert(pending.empty() && panel.done_==panel.queued_);
  panel.queued_=0xfffffffe;panel.done_=0xfffffffe;panel.buffer_sequence_[0]=panel.buffer_sequence_[1]=0xfffffffe;
  fail_at=-1;
  assert(panel.draw16bitRGBBitmap(0,0,pixels.data(),466,466));panel.wait();
  assert(panel.done_==panel.queued_ && pending.empty());
  assert(!panel.draw16bitRGBBitmap(0,0,nullptr,466,466));
  assert(!panel.draw16bitRGBBitmap(0,0,pixels.data(),0,466));
  assert(!panel.draw16bitRGBBitmap(0,1,pixels.data(),466,464));
  assert(!panel.draw16bitRGBBitmap(0,0,pixels.data(),466,465));
}
'''
        with tempfile.TemporaryDirectory(prefix='touch-dma-ownership-') as directory:
            path=pathlib.Path(directory);(path/'test.cpp').write_text(code)
            subprocess.run([shutil.which('clang++') or 'g++','-std=c++17','-O1','-fsanitize=address,undefined',str(path/'test.cpp'),'-o',str(path/'test')],check=True,capture_output=True)
            subprocess.run([str(path/'test')],check=True,capture_output=True)

if __name__=='__main__': unittest.main()
