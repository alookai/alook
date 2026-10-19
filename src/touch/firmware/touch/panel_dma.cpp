/* SPDX-License-Identifier: MIT
Speaker dma_flush.h ping-pong organization adapted to Waveshare CO5300; see third_party/NOTICE.md. */
#include "panel_dma.h"
#include "src/vendor/esp_lcd_co5300/esp_lcd_co5300.h"
#include <driver/spi_master.h>
#include <esp_heap_caps.h>
#include <pin_config.h>
#include <algorithm>
#include <cstring>

namespace alook_touch {
namespace {
const uint8_t init_data[][4] = {{0x20}, {0x10}, {0xA0}, {0x00}, {0x80}, {0x55}, {0x00}, {0x20}, {0xFF}, {0xFF}, {0x00,0x06,0x01,0xD7}, {0x00,0x00,0x01,0xD1}};
const co5300_lcd_init_cmd_t init_commands[] = {
  {0xFE,init_data[0],1,0}, {0x19,init_data[1],1,0}, {0x1C,init_data[2],1,0},
  {0xFE,init_data[3],1,0}, {0xC4,init_data[4],1,0}, {0x3A,init_data[5],1,0},
  {0x35,init_data[6],1,0}, {0x53,init_data[7],1,0}, {0x51,init_data[8],1,0},
  {0x63,init_data[9],1,0}, {0x2A,init_data[10],4,0}, {0x2B,init_data[11],4,600},
  {0x11,nullptr,0,600}, {0x29,nullptr,0,0}
};
}
PanelDma::~PanelDma() {
  wait();
  if (panel_) esp_lcd_panel_del(panel_);
  if (io_) esp_lcd_panel_io_del(io_);
  if (bus_ready_) spi_bus_free(SPI2_HOST);
  for (auto* buffer : ping_) heap_caps_free(buffer);
  if (completion_) vSemaphoreDelete(completion_);
}
bool PanelDma::completed(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* context) {
  auto* self = static_cast<PanelDma*>(context);
  self->done_.fetch_add(1, std::memory_order_release);
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(self->completion_, &woken);
  return woken == pdTRUE;
}
void PanelDma::wait_until(uint32_t sequence) {
  while (static_cast<int32_t>(done_.load(std::memory_order_acquire) - sequence) < 0) xSemaphoreTake(completion_, portMAX_DELAY);
}
void PanelDma::wait() { if (completion_) wait_until(queued_); }
bool PanelDma::begin() {
  completion_ = xSemaphoreCreateBinary();
  for (auto& buffer : ping_) buffer = static_cast<uint16_t*>(heap_caps_malloc(chunk_pixels * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  if (!completion_ || !ping_[0] || !ping_[1]) return false;
  spi_bus_config_t bus = {};
  bus.sclk_io_num = LCD_SCLK; bus.data0_io_num = LCD_SDIO0; bus.data1_io_num = LCD_SDIO1;
  bus.data2_io_num = LCD_SDIO2; bus.data3_io_num = LCD_SDIO3; bus.max_transfer_sz = chunk_pixels * 2;
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return false;
  bus_ready_ = true;
  esp_lcd_panel_io_spi_config_t io = {};
  io.cs_gpio_num = LCD_CS; io.dc_gpio_num = -1; io.spi_mode = 0; io.pclk_hz = 40 * 1000 * 1000;
  io.trans_queue_depth = 8; io.on_color_trans_done = completed; io.user_ctx = this;
  io.lcd_cmd_bits = 32; io.lcd_param_bits = 8; io.flags.quad_mode = true;
  if (esp_lcd_new_panel_io_spi(static_cast<esp_lcd_spi_bus_handle_t>(SPI2_HOST), &io, &io_) != ESP_OK) return false;
  co5300_vendor_config_t vendor = {};
  vendor.init_cmds = init_commands; vendor.init_cmds_size = sizeof(init_commands) / sizeof(init_commands[0]); vendor.flags.use_qspi_interface = true;
  esp_lcd_panel_dev_config_t panel = {};
  panel.reset_gpio_num = LCD_RESET; panel.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB; panel.bits_per_pixel = 16; panel.vendor_config = &vendor;
  if (esp_lcd_new_panel_co5300(io_, &panel, &panel_) != ESP_OK) return false;
  return esp_lcd_panel_set_gap(panel_, 6, 0) == ESP_OK && esp_lcd_panel_reset(panel_) == ESP_OK && esp_lcd_panel_init(panel_) == ESP_OK && esp_lcd_panel_disp_on_off(panel_, true) == ESP_OK;
}
void PanelDma::swap_copy(uint16_t* destination, const uint16_t* source, size_t count) {
  size_t i = 0;
  if ((reinterpret_cast<uintptr_t>(source) & 3) == 0) {
    auto* d = reinterpret_cast<uint32_t*>(destination);
    const auto* s = reinterpret_cast<const uint32_t*>(source);
    for (; i + 1 < count; i += 2) { const uint32_t v = s[i / 2]; d[i / 2] = ((v >> 8) & 0x00FF00FFu) | ((v << 8) & 0xFF00FF00u); }
  }
  for (; i < count; ++i) destination[i] = __builtin_bswap16(source[i]);
}
bool PanelDma::draw16bitRGBBitmap(int x, int y, const uint16_t* pixels, int width, int height) {
  if (!panel_ || !pixels || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 466 || y + height > 466 || ((x | y | width | height) & 1)) return false;
  const int rows_per_chunk = (chunk_pixels / width) & ~1;
  int buffer = 0;
  for (int row = 0; row < height;) {
    const int rows = std::min(rows_per_chunk, height - row);
    wait_until(buffer_sequence_[buffer]);
    swap_copy(ping_[buffer], pixels + row * width, rows * width);
    ++queued_;
    const auto result = esp_lcd_panel_draw_bitmap(panel_, x, y + row, x + width, y + row + rows, ping_[buffer]);
    if (result != ESP_OK) { --queued_; wait(); return false; }
    buffer_sequence_[buffer] = queued_;
    buffer ^= 1; row += rows;
  }
  return true;
}
void PanelDma::setBrightness(uint8_t value) { if (panel_) { wait(); esp_lcd_panel_co5300_set_brightness(panel_, static_cast<uint8_t>(value * 100u / 255)); } }
}
