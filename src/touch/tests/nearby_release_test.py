import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

from display_frame_test import function


ROOT = pathlib.Path(__file__).resolve().parents[1]


class NearbyReleaseTest(unittest.TestCase):
    def test_actual_release_waits_for_worker_and_retires_only_owned_resources(self):
        compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        header = (ROOT / 'firmware/touch/nearby.h').read_text()
        header = '\n'.join(line for line in header.splitlines() if not line.startswith(('#include', '#pragma')))
        header = header.replace('private:', 'public:')
        source = (ROOT / 'firmware/touch/nearby.cpp').read_text()
        program = r'''
#include <atomic>
#include <cassert>
#include <cstdint>
#include <string>
#include <set>
#include "proximity.h"
struct BLEAdvertisedDevice {};
struct BLEAdvertisedDeviceCallbacks { virtual void onResult(BLEAdvertisedDevice) {} };
struct BLEServer {};
struct BLEServerCallbacks { virtual void onDisconnect(BLEServer*) {} };
struct BLEScan {
  int stops=0, clears=0;
  void stop() { ++stops; }
  void clearResults() { ++clears; }
};
struct BLECharacteristic {
  std::string value="Samara#8738";
  void setValue(const char* next) { value=next; }
};
struct Advertising { int stops=0; void stop() { ++stops; } } advertising;
int deinits=0, locks=0, wakes=0;
struct BLEDevice {
  static Advertising* getAdvertising() { return &advertising; }
  static void deinit(bool release_memory) { assert(!release_memory && locks==0); ++deinits; }
};
using QueueHandle_t=void*;
using SemaphoreHandle_t=void*;
constexpr int portMAX_DELAY=1;
std::set<void*> deleted, reset;
void xSemaphoreTake(void* value,int) { assert(value && !deleted.count(value)); ++locks; }
void xSemaphoreGive(void* value) { assert(value && locks==1); --locks; }
void xQueueReset(void* value) { assert(value && !deleted.count(value)); reset.insert(value); }
void xQueueOverwrite(void* value,const void*) { assert(value && !deleted.count(value)); ++wakes; }
void vQueueDelete(void* value) { assert(value && deleted.insert(value).second); }
void vSemaphoreDelete(void* value) { assert(value && locks==0 && deleted.insert(value).second); }
'''
        program += header + '\nnamespace alook_touch {\n'
        program += function(source, 'void Nearby::stop(') + '\n' + function(source, 'bool Nearby::release(') + '\nvoid Nearby::onResult(BLEAdvertisedDevice) {}\n}\n'
        program += r'''
int main() {
  using namespace alook_touch;
  Nearby nearby;
  BLEScan scan; BLECharacteristic characteristic;
  int observation=0, job=0, result=0, mutex=0;
  nearby.observations_=&observation; nearby.jobs_=&job; nearby.results_=&result; nearby.radio_=&mutex;
  nearby.scan_=&scan; nearby.characteristic_=&characteristic; nearby.owns_radio_=true;
  nearby.active_=true; nearby.reading_=true; nearby.worker_done_=false;
  nearby.own_handle_="Samara#8738"; nearby.peer_handle_="Gener#6185"; nearby.peer_address_="peer";
  assert(!nearby.release());
  assert(nearby.releasing_ && !nearby.active_ && nearby.reading_);
  assert(scan.stops==1 && scan.clears==1 && advertising.stops==1);
  assert(characteristic.value.empty() && nearby.own_handle_.empty() && nearby.peer_handle_.empty() && nearby.peer_address_.empty());
  assert(nearby.generation_==1 && wakes==1 && reset.size()==2 && locks==0);
  assert(deleted.empty() && deinits==0 && nearby.jobs_==&job && nearby.radio_==&mutex);
  assert(!nearby.release());
  assert(nearby.generation_==1 && wakes==1 && scan.stops==1 && deinits==0 && deleted.empty());
  nearby.worker_done_=true;
  assert(nearby.release());
  assert(deinits==1 && deleted.size()==4 && !nearby.owns_radio_ && !nearby.reading_ && !nearby.releasing_);
  assert(!nearby.observations_ && !nearby.jobs_ && !nearby.results_ && !nearby.radio_ && !nearby.scan_ && !nearby.characteristic_);
  assert(nearby.release());
  assert(deinits==1 && deleted.size()==4 && wakes==1);
  int partial=0, next_mutex=0;
  nearby.observations_=&partial; nearby.radio_=&next_mutex;
  assert(nearby.release());
  assert(deinits==1 && deleted.size()==6 && locks==0);
  int next_job=0;
  nearby.jobs_=&next_job; nearby.owns_radio_=true; nearby.worker_done_=false; nearby.active_=true;
  assert(!nearby.release());
  assert(wakes==2 && deinits==1 && !nearby.active_ && !deleted.count(&next_job));
  nearby.worker_done_=true;
  assert(nearby.release());
  assert(deinits==2 && deleted.count(&next_job) && !nearby.jobs_);
}
'''
        with tempfile.TemporaryDirectory(prefix='alook-touch-nearby-') as directory:
            path = pathlib.Path(directory)
            (path / 'test.cpp').write_text(program)
            built = subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I' + str(ROOT / 'firmware/touch'), str(path / 'test.cpp'), '-o', str(path / 'test')], capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(path / 'test')], capture_output=True, text=True)
            self.assertEqual(ran.returncode, 0, ran.stderr)


if __name__ == '__main__':
    unittest.main()
