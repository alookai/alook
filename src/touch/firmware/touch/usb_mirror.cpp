#include "usb_mirror.h"
#if ALOOK_TOUCH_USB_MIRROR
#include "usb_mirror_protocol.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_rom_crc.h>
#include <algorithm>
#include <cstring>

namespace alook_touch {
namespace {
constexpr size_t width = 466, height = 466, frame_bytes = width * height * 2;
uint8_t* live = nullptr;
uint8_t* snapshot = nullptr;
UsbMirrorInput input;
uint8_t header[28]{};
size_t sent = 0;
bool transmitting = false;
uint32_t sequence = 0, progress_at = 0;

void put16(size_t offset, uint16_t value) { header[offset] = value; header[offset + 1] = value >> 8; }
void put32(size_t offset, uint32_t value) { for (size_t i = 0; i < 4; ++i) header[offset + i] = value >> (i * 8); }
void start_frame() {
  std::memcpy(snapshot, live, frame_bytes);
  std::memcpy(header, "ALM1", 4);
  put32(4, frame_bytes); put32(8, ++sequence);
  put32(12, esp_rom_crc32_le(0, snapshot, frame_bytes));
  put16(16, width); put16(18, height);
  const auto ip = WiFi.localIP();
  for (size_t i = 0; i < 4; ++i) header[20 + i] = ip[i];
  put32(24, WiFi.status() == WL_CONNECTED ? 1 : 0);
  sent = 0; transmitting = true; progress_at = millis();
}
}

bool usb_mirror_begin() {
  static_assert(sizeof(lv_color_t) == 2, "USB mirror requires RGB565");
  live = static_cast<uint8_t*>(heap_caps_calloc(1, frame_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  snapshot = static_cast<uint8_t*>(heap_caps_malloc(frame_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!live || !snapshot) { heap_caps_free(live); heap_caps_free(snapshot); live = snapshot = nullptr; return false; }
  Serial.setTxBufferSize(8192);
  Serial.setTxTimeoutMs(0);
  return true;
}

void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels) {
  if (!live || area->x1 < 0 || area->y1 < 0 || area->x2 >= width || area->y2 >= height) return;
  const auto columns = static_cast<size_t>(area->x2 - area->x1 + 1);
  for (int y = area->y1; y <= area->y2; ++y)
    std::memcpy(live + (static_cast<size_t>(y) * width + area->x1) * 2,
      pixels + static_cast<size_t>(y - area->y1) * columns, columns * 2);
}

void usb_mirror_tick() {
  if (!live) return;
  for (size_t n = 0; n < 256 && Serial.available(); ++n) input.feed(static_cast<char>(Serial.read()), millis());
  if (input.wifi_requested) {
    input.wifi_requested = false;
    WiFi.begin(input.wifi_ssid, input.wifi_password);
    std::memset(input.wifi_ssid, 0, sizeof(input.wifi_ssid));
    std::memset(input.wifi_password, 0, sizeof(input.wifi_password));
  }
  if (!transmitting && input.snapshot) { input.snapshot = false; start_frame(); }
  if (!transmitting) return;
  const auto now = millis();
  if (uint32_t(now - progress_at) > 2000) { transmitting = false; return; }
  const int available = Serial.availableForWrite();
  if (available <= 0) return;
  const size_t total = sizeof(header) + frame_bytes;
  const bool in_header = sent < sizeof(header);
  const size_t remaining = in_header ? sizeof(header) - sent : total - sent;
  const size_t count = std::min<size_t>({static_cast<size_t>(available), remaining, 4096});
  const uint8_t* bytes = in_header ? header + sent : snapshot + sent - sizeof(header);
  const size_t written = Serial.write(bytes, count);
  sent += written;
  if (written) progress_at = now;
  if (sent == total) transmitting = false;
}

bool usb_mirror_pointer(lv_indev_data_t* data) {
  int x = 0, y = 0; bool down = false;
  if (!input.pointer(millis(), x, y, down)) return false;
  data->point.x = x; data->point.y = y;
  data->state = down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
  return true;
}
bool usb_mirror_record() { return input.record(millis()); }
bool usb_mirror_home() { return input.take_home(); }
}
#endif
