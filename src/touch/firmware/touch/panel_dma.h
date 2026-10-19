/* SPDX-License-Identifier: MIT
Speaker DMA buffer ownership and swap-copy adapted for the official CO5300 QSPI driver; see third_party/NOTICE.md. */
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_ops.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace alook_touch {
class PanelDma {
public:
  ~PanelDma();
  bool begin();
  void setBrightness(uint8_t value);
  bool draw16bitRGBBitmap(int x, int y, const uint16_t* pixels, int width, int height);
  void wait();
  static void swap_copy(uint16_t* destination, const uint16_t* source, size_t count);
private:
  static constexpr int chunk_pixels = 16380;
  esp_lcd_panel_io_handle_t io_ = nullptr;
  esp_lcd_panel_handle_t panel_ = nullptr;
  SemaphoreHandle_t completion_ = nullptr;
  uint16_t* ping_[2]{};
  uint32_t buffer_sequence_[2]{};
  uint32_t queued_ = 0;
  std::atomic<uint32_t> done_{0};
  bool bus_ready_ = false;
  static bool completed(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* context);
  void wait_until(uint32_t sequence);
};
}
