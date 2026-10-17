#pragma once
#include <cerrno>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace alook_touch {
class UsbMirrorInput {
 public:
  bool snapshot = false;
  bool wifi_requested = false;
  char wifi_ssid[33]{}, wifi_password[64]{};

  void feed(char value, uint32_t now) {
    if (value == '\r') return;
    if (value == '\n') {
      if (!overflow_) { line_[used_] = 0; apply(now); }
      std::memset(line_, 0, sizeof(line_));
      used_ = 0; overflow_ = false;
      return;
    }
    if (value < 32 || value > 126 || used_ == sizeof(line_) - 1) { overflow_ = true; return; }
    if (!overflow_) line_[used_++] = value;
  }

  bool pointer(uint32_t now, int& x, int& y, bool& down) {
    if (!pointer_seen_ || uint32_t(now - pointer_at_) > 750) { queued_ = 0; pointer_down_ = false; return false; }
    if (queued_) {
      const auto point = pointers_[read_];
      read_ = (read_ + 1) % pointers_.size(); --queued_;
      x_ = point.x; y_ = point.y; pointer_down_ = point.down;
    }
    x = x_; y = y_; down = pointer_down_;
    return true;
  }
  bool record(uint32_t now) const { return record_down_ && uint32_t(now - record_at_) <= 1000; }
  bool take_home() { const bool value = home_; home_ = false; return value; }

 private:
  char line_[256]{};
  size_t used_ = 0;
  bool overflow_ = false, pointer_seen_ = false, pointer_down_ = false, record_down_ = false, home_ = false;
  int x_ = 0, y_ = 0;
  uint32_t pointer_at_ = 0, record_at_ = 0;
  struct Pointer { int x = 0, y = 0; bool down = false; };
  std::array<Pointer, 8> pointers_{};
  size_t read_ = 0, queued_ = 0;

  static int hex_digit(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
  }
  static bool decode(const char*& text, char* output, size_t limit, size_t& count) {
    count = 0;
    while (*text && *text != ' ') {
      const int high = hex_digit(*text++);
      if (high < 0 || !*text) return false;
      const int low = hex_digit(*text++);
      if (low < 0 || count == limit || !(high || low)) return false;
      output[count++] = static_cast<char>(high * 16 + low);
    }
    output[count] = 0;
    return true;
  }

  static bool number(const char*& text, long& value) {
    if (*text < '0' || *text > '9') return false;
    char* end = nullptr;
    errno = 0; value = std::strtol(text, &end, 10);
    if (errno || end == text) return false;
    text = end;
    return true;
  }
  void apply(uint32_t now) {
    if (std::strcmp(line_, "F") == 0) { snapshot = true; return; }
    if (std::strcmp(line_, "H") == 0) { home_ = true; return; }
    if (line_[0] == 'W' && line_[1] == ' ') {
      std::memset(wifi_ssid, 0, sizeof(wifi_ssid));
      std::memset(wifi_password, 0, sizeof(wifi_password));
      wifi_requested = false;
      const char* text = line_ + 2; size_t ssid_size = 0, password_size = 0;
      if (!decode(text, wifi_ssid, 32, ssid_size) || !ssid_size || *text++ != ' ') return;
      const bool open = std::strcmp(text, "-") == 0;
      if (!open && (!decode(text, wifi_password, 63, password_size) || *text || password_size < 8)) {
        std::memset(wifi_password, 0, sizeof(wifi_password)); return;
      }
      wifi_requested = true;
      return;
    }
    if (line_[0] == 'R' && line_[1] == ' ') {
      const char* text = line_ + 2; long pressed = 0;
      if (number(text, pressed) && !*text && pressed <= 1) { record_down_ = pressed; record_at_ = now; }
      return;
    }
    if (line_[0] != 'T' || line_[1] != ' ') return;
    const char* text = line_ + 2; long x = 0, y = 0, down = 0;
    if (!number(text, x) || *text++ != ' ' || !number(text, y) || *text++ != ' ' || !number(text, down) || *text) return;
    if (x > 465 || y > 465 || down > 1) return;
    const Pointer point{static_cast<int>(x), static_cast<int>(y), down != 0};
    if (queued_ && pointers_[(read_ + queued_ - 1) % pointers_.size()].down == point.down)
      pointers_[(read_ + queued_ - 1) % pointers_.size()] = point;
    else if (queued_ == pointers_.size()) { queued_ = 0; pointer_down_ = false; }
    else { pointers_[(read_ + queued_) % pointers_.size()] = point; ++queued_; }
    pointer_seen_ = true; pointer_at_ = now;
  }
};
}
