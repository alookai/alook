#include "../firmware/touch/speaker_motion.h"
#include <cassert>
#include <iostream>

using namespace alook_touch;
int main() {
  SpeakerIdle idle;
  bool blinked = false;
  for (int i = 0; i < 30000; ++i) {
    const auto p = idle.at(i * 0.01f);
    assert(std::isfinite(p.x) && p.x >= -1 && p.x <= 1);
    assert(std::isfinite(p.y) && p.y >= -1 && p.y <= 1);
    assert(std::isfinite(p.eyes) && p.eyes >= 0 && p.eyes <= 1);
    blinked |= p.eyes < 0.1f;
  }
  assert(blinked);
  assert(idle.at(0).eyes == 1);
  SpeakerMenu fast, slow;
  for (int focus = 0; focus < static_cast<int>(fast.bubbles.size()); ++focus) {
    fast.focused = slow.focused = focus;
    for (int i = 0; i < 2000; ++i) fast.step(0.016f);
    for (int i = 0; i < 400; ++i) slow.step(0.080f);
    for (size_t i = 0; i < fast.bubbles.size(); ++i) {
      const auto b = fast.bubbles[i];
      assert(std::isfinite(b.x) && std::isfinite(b.y) && std::isfinite(b.radius));
      assert(b.y - b.radius >= 81.9f);
      assert(std::abs(b.x - slow.bubbles[i].x) < 0.1f);
      assert(std::abs(b.y - slow.bubbles[i].y) < 0.1f);
    }
  }
  const auto before = fast.bubbles;
  fast.step(NAN);
  assert(before[0].x == fast.bubbles[0].x);
  std::cout << "Speaker motion bounds and frame-rate controls passed\n";
}
