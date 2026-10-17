#include "../firmware/touch/usb_mirror_protocol.h"
#include <cassert>
#include <cstdint>
#include <string>

using alook_touch::UsbMirrorInput;
static void feed(UsbMirrorInput& input, const std::string& text, uint32_t now) {
  for (char value : text) input.feed(value, now);
}
int main() {
  UsbMirrorInput input;
  int x = -1, y = -1; bool down = false;
  assert(!input.pointer(0, x, y, down));
  feed(input, "T 465 0 1\n", 100);
  assert(input.pointer(100, x, y, down) && x == 465 && y == 0 && down);
  assert(input.pointer(850, x, y, down));
  assert(!input.pointer(851, x, y, down));
  for (const auto* bad : {"T 466 0 1\n", "T -1 0 1\n", "T 1 466 1\n", "T 1 2 2\n", "T 1 2 1 extra\n", "T 99999999999999999999999999 2 1\n", "T 1 2\n"}) feed(input, bad, 900);
  assert(!input.pointer(900, x, y, down));
  feed(input, std::string(100, 'x') + "T 1 2 1\n", 900);
  assert(!input.pointer(900, x, y, down));
  feed(input, "T 1 2 0\r\n", 950);
  assert(input.pointer(950, x, y, down) && x == 1 && y == 2 && !down);
  feed(input, "R 1\n", 1000);
  assert(input.record(2000)); assert(!input.record(2001));
  feed(input, "R 1\nR 0\n", 3000); assert(!input.record(3000));
  feed(input, "H\n", 0); assert(input.take_home()); assert(!input.take_home());
  feed(input, "F\n", 0); assert(input.snapshot);
  feed(input, "R 1\nT 3 4 1\n", UINT32_MAX - 100);
  assert(input.record(100)); assert(input.pointer(100, x, y, down) && down);
  assert(!input.record(1100)); assert(!input.pointer(1100, x, y, down));
  UsbMirrorInput clicks;
  feed(clicks, "T 10 20 1\nT 10 20 0\n", 100);
  assert(clicks.pointer(100, x, y, down) && down);
  assert(clicks.pointer(130, x, y, down) && !down);
  feed(clicks, "T 1 2 1\nT 2 3 1\nT 3 4 1\nT 3 4 0\n", 200);
  assert(clicks.pointer(200, x, y, down) && down && x == 3 && y == 4);
  assert(clicks.pointer(230, x, y, down) && !down);
  for (int i = 0; i < 9; ++i) feed(clicks, "T 0 0 " + std::to_string(i % 2) + "\n", 300);
  assert(clicks.pointer(300, x, y, down) && !down);
  feed(clicks, std::string(300, 'x') + "\nT 10 20 1\n", 400);
  assert(clicks.pointer(400, x, y, down) && down);
  assert(!clicks.pointer(1200, x, y, down));
  feed(input, "W 74657374 70617373776f7264\n", 0);
  assert(input.wifi_requested && std::string(input.wifi_ssid) == "test" && std::string(input.wifi_password) == "password");
  feed(input, "W 74657374 -\n", 0);
  assert(input.wifi_requested && !input.wifi_password[0]);
  for (const auto* bad : {"W 00 -\n", "W 74657374 313233\n", "W 74657374 zz\n", "W 74657374 - extra\n", "W 7465737 -\n"}) {
    feed(input, bad, 0); assert(!input.wifi_requested);
  }
}
