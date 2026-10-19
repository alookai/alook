#include "usb_mirror.h"
#if ALOOK_TOUCH_USB_MIRROR
#include "usb_mirror_protocol.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_rom_crc.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/task.h>
#include <algorithm>
#include <cstring>

namespace alook_touch {
namespace {
constexpr size_t width = 466, height = 466, frame_bytes = width * height * 2;
const uint8_t* live = nullptr;
uint8_t* snapshot = nullptr;
UsbMirrorInput input;
uint8_t header[256]{};
uint32_t profile[10]{};
uint32_t display_diagnostic[4]{};
uint32_t display_costs[18]{};
uint32_t http_diagnostic[8]{};
uint32_t http_connection[7]{};
portMUX_TYPE diagnostic_mux = portMUX_INITIALIZER_UNLOCKED;
size_t sent = 0;
bool transmitting = false;
uint32_t sequence = 0, progress_at = 0;

void put16(size_t offset, uint16_t value) { header[offset] = value; header[offset + 1] = value >> 8; }
void put32(size_t offset, uint32_t value) { for (size_t i = 0; i < 4; ++i) header[offset + i] = value >> (i * 8); }
void start_frame() {
  std::memcpy(snapshot, live, frame_bytes);
  std::memcpy(header, "ALM9", 4);
  put32(4, frame_bytes); put32(8, ++sequence);
  put32(12, esp_rom_crc32_le(0, snapshot, frame_bytes));
  put16(16, width); put16(18, height);
  const auto ip = WiFi.localIP();
  for (size_t i = 0; i < 4; ++i) header[20 + i] = ip[i];
  put32(24, WiFi.status() == WL_CONNECTED ? 1 : 0);
  uint32_t diagnostic[8];
  uint32_t connection[7];
  uint32_t costs[18];
  portENTER_CRITICAL(&diagnostic_mux);
  std::memcpy(diagnostic, http_diagnostic, sizeof(diagnostic));
  std::memcpy(connection, http_connection, sizeof(connection));
  std::memcpy(costs, display_costs, sizeof(costs));
  portEXIT_CRITICAL(&diagnostic_mux);
  for (size_t i = 0; i < 8; ++i) put32(28 + i * 4, diagnostic[i]);
  const IPAddress addresses[] = {WiFi.subnetMask(), WiFi.gatewayIP(), WiFi.dnsIP(0), WiFi.dnsIP(1)};
  for (size_t n = 0; n < 4; ++n) for (size_t i = 0; i < 4; ++i) header[60 + n * 4 + i] = addresses[n][i];
  put32(76, connection[0]); put32(80, WiFi.RSSI()); put32(84, WiFi.channel()); put32(88, WiFi.status());
  for (size_t i = 1; i < 7; ++i) put32(88 + i * 4, connection[i]);
  put32(116, millis());
  for (size_t i = 0; i < 4; ++i) put32(120 + i * 4, display_diagnostic[i]);
  put32(136, static_cast<uint32_t>(esp_reset_reason()));
  put32(140, uxTaskGetStackHighWaterMark(nullptr));
  for (size_t i = 0; i < 18; ++i) put32(144 + i * 4, costs[i]);
  for (size_t i = 0; i < 10; ++i) put32(216 + i * 4, profile[i]);
  sent = 0; transmitting = true; progress_at = millis();
}
}

uint32_t usb_mirror_micros() { return static_cast<uint32_t>(esp_timer_get_time()); }
void usb_mirror_profile(UsbMirrorProfileField field, uint32_t value) { profile[field] = value; }

bool usb_mirror_begin() {
  static_assert(sizeof(lv_color_t) == 2, "USB mirror requires RGB565");
  snapshot = static_cast<uint8_t*>(heap_caps_malloc(frame_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!snapshot) return false;
  Serial.setTxBufferSize(8192);
  Serial.setTxTimeoutMs(0);
  return true;
}

void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels) {
  if (area->x1 == 0 && area->y1 == 0 && area->x2 == width - 1 && area->y2 == height - 1)
    live = reinterpret_cast<const uint8_t*>(pixels);
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
  size_t budget = 8192;
  const size_t total = sizeof(header) + frame_bytes;
  while (budget && sent < total) {
    const int available = Serial.availableForWrite();
    if (available <= 0) break;
    const bool in_header = sent < sizeof(header);
    const size_t remaining = in_header ? sizeof(header) - sent : total - sent;
    const size_t count = std::min<size_t>({static_cast<size_t>(available), remaining, budget});
    const uint8_t* bytes = in_header ? header + sent : snapshot + sent - sizeof(header);
    const size_t written = Serial.write(bytes, count);
    if (!written) break;
    sent += written; budget -= written; progress_at = now;
  }
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
void usb_mirror_display(uint32_t elapsed, uint32_t pixels, uint32_t refresh, uint32_t panel, uint32_t mirror) {
  if (!pixels) return;
  ++display_diagnostic[0]; display_diagnostic[1] += elapsed;
  display_diagnostic[2] = std::max(display_diagnostic[2], elapsed); display_diagnostic[3] = elapsed;
  display_costs[0] += refresh; display_costs[1] += panel; display_costs[2] += mirror;
  display_costs[3] = refresh; display_costs[4] = panel; display_costs[5] = mirror;
}
void usb_mirror_render(uint32_t elapsed, uint32_t body) {
  display_costs[16] = body; display_costs[17] = elapsed - body;
  display_costs[13] += elapsed; display_costs[14] = elapsed;
  display_costs[15] = std::max(display_costs[15], elapsed);
}
void usb_mirror_work(bool decode, uint32_t elapsed) {
  const auto stack_free = decode ? uxTaskGetStackHighWaterMark(nullptr) : 0;
  portENTER_CRITICAL(&diagnostic_mux);
  const size_t offset = decode ? 9 : 6;
  display_costs[offset] += elapsed; display_costs[offset + 1] = elapsed;
  display_costs[offset + 2] = std::max(display_costs[offset + 2], elapsed);
  if (decode) display_costs[12] = stack_free;
  portEXIT_CRITICAL(&diagnostic_mux);
}
void usb_mirror_http(const UsbMirrorHttpDiagnostic& value) {
  portENTER_CRITICAL(&diagnostic_mux);
  ++http_diagnostic[0]; http_diagnostic[1] = value.operation;
  http_diagnostic[2] = static_cast<uint32_t>(value.error); http_diagnostic[3] = static_cast<uint32_t>(value.status);
  http_diagnostic[4] = value.bytes; http_diagnostic[5] = value.elapsed;
  http_diagnostic[6] = static_cast<uint32_t>(value.socket_errno); http_diagnostic[7] = value.stage;
  http_connection[0] = value.target_address; http_connection[1] = value.target_port;
  http_connection[2] = static_cast<uint32_t>(value.system_errno); http_connection[3] = static_cast<uint32_t>(value.tls_error);
  http_connection[4] = static_cast<uint32_t>(value.tls_flags); http_connection[5] = static_cast<uint32_t>(value.tls_code);
  http_connection[6] = static_cast<uint32_t>(value.socket);
  portEXIT_CRITICAL(&diagnostic_mux);
}
}
#endif
