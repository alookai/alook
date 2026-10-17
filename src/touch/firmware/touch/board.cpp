/* SPDX-License-Identifier: Apache-2.0
Modified from Waveshare ESP32-S3-Touch-AMOLED-1.75C examples; see third_party/NOTICE.md. */
#include "board.h"
#include "usb_mirror.h"
#include <Arduino_GFX_Library.h>
#include <TouchDrvCSTXXX.hpp>
#include <Wire.h>
#include <XPowersLib.h>
#include <esp_heap_caps.h>
#include <pin_config.h>

namespace alook_touch {
namespace {
Arduino_ESP32QSPI bus(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
Arduino_CO5300 display(&bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 6, 0, 0, 0);
TouchDrvCST92xx touch;
XPowersAXP2101 power;
bool touch_ready = false;
bool power_ready = false;
bool previous_record = false;
bool sampled_record = false;
uint32_t record_changed = 0;
uint32_t power_sampled = 0;
uint32_t tick_at = 0;

void round_area(lv_disp_drv_t*, lv_area_t* area) {
  area->x1 &= ~1;
  area->y1 &= ~1;
  area->x2 |= 1;
  area->y2 |= 1;
}

void flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* pixels) {
  usb_mirror_flush(area, pixels);
  display.draw16bitRGBBitmap(area->x1, area->y1, &pixels->full,
    area->x2 - area->x1 + 1, area->y2 - area->y1 + 1);
  lv_disp_flush_ready(driver);
}

void read_touch(lv_indev_drv_t*, lv_indev_data_t* data) {
  if (usb_mirror_pointer(data)) return;
  int16_t x = 0, y = 0;
  if (touch_ready && touch.getPoint(&x, &y, 1) > 0 && x >= 0 && y >= 0 && x < LCD_WIDTH && y < LCD_HEIGHT) {
    data->state = LV_INDEV_STATE_PRESSED;
    data->point.x = x;
    data->point.y = y;
  } else data->state = LV_INDEV_STATE_RELEASED;
}
}

bool board_begin() {
  Serial.begin(115200);
  pinMode(0, INPUT_PULLUP);
  previous_record = sampled_record = digitalRead(0) == LOW;
  Wire.begin(IIC_SDA, IIC_SCL);
  power_ready = power.begin(Wire, AXP2101_SLAVE_ADDRESS, IIC_SDA, IIC_SCL);
  if (power_ready) {
    power.enableBattDetection();
    power.enableBattVoltageMeasure();
    power.clearIrqStatus();
    power.enableIRQ(XPOWERS_AXP2101_PKEY_SHORT_IRQ);
  }
  touch.setPins(TP_RST, TP_INT);
  touch_ready = touch.begin(Wire, 0x5A, IIC_SDA, IIC_SCL);
  if (touch_ready) {
    touch.setMaxCoordinates(LCD_WIDTH, LCD_HEIGHT);
    touch.setMirrorXY(true, true);
  }
  if (!display.begin()) return false;
  display.setBrightness(180);
  lv_init();
  if (!usb_mirror_begin()) return false;
  constexpr size_t pixel_count = LCD_WIDTH * 40;
  auto* pixels = static_cast<lv_color_t*>(heap_caps_malloc(pixel_count * sizeof(lv_color_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  if (!pixels) return false;
  static lv_disp_draw_buf_t buffer;
  lv_disp_draw_buf_init(&buffer, pixels, nullptr, pixel_count);
  static lv_disp_drv_t driver;
  lv_disp_drv_init(&driver);
  driver.hor_res = LCD_WIDTH;
  driver.ver_res = LCD_HEIGHT;
  driver.flush_cb = flush;
  driver.rounder_cb = round_area;
  driver.draw_buf = &buffer;
  lv_disp_drv_register(&driver);
  static lv_indev_drv_t input;
  lv_indev_drv_init(&input);
  input.type = LV_INDEV_TYPE_POINTER;
  input.read_cb = read_touch;
  lv_indev_drv_register(&input);
  tick_at = millis();
  return true;
}

void board_tick() {
  usb_mirror_tick();
  const auto now = millis();
  lv_tick_inc(now - tick_at);
  tick_at = now;
  lv_timer_handler();
}

ButtonEvents board_buttons() {
  ButtonEvents events{};
  const auto now = millis();
  const bool pressed = digitalRead(0) == LOW || usb_mirror_record();
  if (pressed != sampled_record) { sampled_record = pressed; record_changed = now; }
  if (sampled_record != previous_record && now - record_changed >= 30) {
    previous_record = sampled_record;
    events.record_pressed = previous_record;
    events.record_released = !previous_record;
  }
  if (power_ready && now - power_sampled >= 50) {
    power_sampled = now;
    power.getIrqStatus();
    events.home = power.isPekeyShortPressIrq();
    power.clearIrqStatus();
  }
  const bool remote_home = usb_mirror_home();
  events.home = events.home || remote_home;
  return events;
}

int board_battery() { return power_ready && power.isBatteryConnect() ? power.getBatteryPercent() : -1; }
bool board_charging() { return power_ready && power.isCharging(); }
void board_brightness(uint8_t value) { display.setBrightness(value); }
}
