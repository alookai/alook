import pathlib
import shutil
import subprocess
import tempfile
import unittest


class ApplicationClock(unittest.TestCase):
    def test_actual_tick_resamples_after_response_and_portal_work(self):
        source = pathlib.Path(__file__).resolve().parents[1] / 'firmware/touch/application.cpp'
        text = source.read_text()
        start = text.index('void Application::tick() {')
        end = text.index('  if (state_.page == Page::Startup', start)
        prefix = text[start:end]
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        harness = r'''
#include <cassert>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>
uint32_t current_time = 0;
uint32_t millis() { return current_time; }
void esp_restart() { assert(false); }
void configTime(int, int, const char*, const char*) {}
constexpr int WL_CONNECTED = 3;
struct Wifi { int status() { return WL_CONNECTED; } } WiFi;
void retire_presence(std::vector<int>&) {}
struct Response {};
struct Network {
  unsigned remaining = 0;
  std::unique_ptr<Response> receive() {
    if (!remaining) return nullptr;
    --remaining;
    return std::make_unique<Response>();
  }
};
struct Portal { uint32_t step = 0; void process() { current_time += step; } };
struct Nearby { void stop() {} };
struct Data {
  bool bot_online = false;
  std::vector<int> dms;
  std::string peer_name, peer_handle, peer_state, status;
};
class Application {
public:
  Network network_;
  Portal provisioning_;
  Nearby nearby_;
  Data data_;
  bool portal_ = false, online_ = true;
  uint32_t restart_at_ = 0, observed_time = 0, response_step = 0;
  uint32_t auth_start_ = 0, validated_at_ = 0, dms_at_ = 0, metadata_at_ = 0, history_at_ = 0;
  unsigned processed = 0;
  std::string broadcast_handle_, peer_code_, peer_id_;
  void response(Response) {
    ++processed;
    current_time += response_step;
    auth_start_ = validated_at_ = dms_at_ = metadata_at_ = history_at_ = current_time;
  }
  void tick();
};
'''
        harness += prefix + r'''
  observed_time = now;
}
void verify_fresh_deadlines(const Application& app) {
  assert(uint32_t(app.observed_time - app.auth_start_) < 300000);
  for (uint32_t start : {app.validated_at_, app.dms_at_, app.metadata_at_, app.history_at_})
    assert(uint32_t(app.observed_time - start) < 15000);
}
int main() {
  for (uint32_t start : {1000u, std::numeric_limits<uint32_t>::max() - 1}) {
    current_time = start;
    Application app;
    app.network_.remaining = 1;
    app.response_step = 4;
    app.tick();
    assert(app.processed == 1 && app.observed_time == current_time);
    verify_fresh_deadlines(app);
  }
  current_time = 2000;
  Application portal;
  portal.portal_ = true;
  portal.provisioning_.step = 3;
  portal.tick();
  assert(portal.observed_time == 2003);
  current_time = 4000;
  Application bounded;
  bounded.network_.remaining = 13;
  bounded.response_step = 2;
  bounded.tick();
  assert(bounded.processed == 12 && bounded.network_.remaining == 1);
  assert(bounded.observed_time == 4024);
  verify_fresh_deadlines(bounded);
  for (uint32_t start : {1000u, std::numeric_limits<uint32_t>::max() - 1000}) {
    Application normal;
    normal.auth_start_ = start;
    current_time = start + 299999u;
    normal.tick();
    assert(uint32_t(normal.observed_time - normal.auth_start_) < 300000);
    current_time = start + 300000u;
    normal.tick();
    assert(uint32_t(normal.observed_time - normal.auth_start_) >= 300000);
    for (uint32_t interval : {1000u, 15000u}) {
      current_time = start + interval;
      normal.tick();
      assert(uint32_t(normal.observed_time - start) >= interval);
    }
  }
}
'''
        with tempfile.TemporaryDirectory(prefix='alook-touch-tick-clock-') as directory:
            root = pathlib.Path(directory)
            test = root / 'tick.cpp'
            binary = root / 'tick'
            test.write_text(harness)
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', str(test), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
