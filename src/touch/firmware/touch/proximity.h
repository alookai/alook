#pragma once
#include <cstdint>
#include <string>

namespace alook_touch {
class Proximity {
public:
  void reset() { candidate_.clear(); peer_.clear(); count_ = 0; last_ = 0; strength_ = -100; }
  void observe(const std::string& code, int rssi, uint32_t now) {
    if (code.empty() || code.size() > 160 || rssi > 0 || rssi < -127) return;
    if (candidate_ != code || now - last_ > 2500) { candidate_ = code; peer_.clear(); count_ = 0; strength_ = rssi; }
    strength_ = (strength_ * 3 + rssi) / 4;
    last_ = now;
    if (strength_ >= -62 && ++count_ >= 3) peer_ = code;
    else if (strength_ < -72) { peer_.clear(); count_ = 0; }
  }
  std::string peer(uint32_t now) {
    if (now - last_ > 2500) reset();
    return peer_;
  }
private:
  std::string candidate_;
  std::string peer_;
  unsigned count_ = 0;
  uint32_t last_ = 0;
  int strength_ = -100;
};
}
