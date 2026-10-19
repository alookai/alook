/* SPDX-License-Identifier: Apache-2.0
Modified from Waveshare ESP32-S3-Touch-AMOLED-1.75C examples; see third_party/NOTICE.md. */
#include "board.h"
#include "usb_mirror.h"
#include "panel_dma.h"
#include <TouchDrvCSTXXX.hpp>
#include <Wire.h>
#include <XPowersLib.h>
#include <esp_heap_caps.h>
#include <pin_config.h>
#include <cstring>

namespace alook_touch {
namespace {
PanelDma display;
TouchDrvCST92xx touch;
XPowersAXP2101 power;
bool touch_ready = false;
bool power_ready = false;
bool previous_record = false;
bool sampled_record = false;
uint32_t record_changed = 0;
uint32_t power_sampled = 0;
uint32_t refresh_started_at = 0;
int dirty_top = LCD_HEIGHT, dirty_bottom = -1;
#if ALOOK_TOUCH_USB_MIRROR
uint32_t panel_ms = 0, mirror_ms = 0;
uint32_t image_draw_us = 0, image_draw_calls = 0, image_fast_calls = 0;
void (*software_image)(lv_draw_ctx_t*, const lv_draw_img_dsc_t*, const lv_area_t*, const uint8_t*, lv_img_cf_t) = nullptr;
void profile_image(lv_draw_ctx_t* context, const lv_draw_img_dsc_t* descriptor, const lv_area_t* coordinates, const uint8_t* source, lv_img_cf_t format) {
  const auto started = usb_mirror_micros();
  const bool fast = !lv_draw_mask_is_any(context->clip_area) && descriptor->angle == 0 && descriptor->zoom == LV_IMG_ZOOM_NONE && format == LV_IMG_CF_TRUE_COLOR && descriptor->recolor_opa == LV_OPA_TRANSP && descriptor->opa >= LV_OPA_MAX;
  software_image(context, descriptor, coordinates, source, format);
  image_draw_us += usb_mirror_micros() - started;
  ++image_draw_calls; image_fast_calls += fast;
}
#endif

void round_area(lv_disp_drv_t*, lv_area_t* area) {
  area->x1 &= ~1;
  area->y1 &= ~1;
  area->x2 |= 1;
  area->y2 |= 1;
}

void flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* pixels) {
  const auto* dirty = driver->draw_ctx && driver->draw_ctx->clip_area ? driver->draw_ctx->clip_area : area;
  dirty_top = std::min(dirty_top, static_cast<int>(dirty->y1));
  dirty_bottom = std::max(dirty_bottom, static_cast<int>(dirty->y2));
  if (lv_disp_flush_is_last(driver)) {
    const lv_area_t frame = {0, 0, LCD_WIDTH - 1, LCD_HEIGHT - 1};
#if ALOOK_TOUCH_USB_MIRROR
    const auto mirror_started = millis();
#endif
    usb_mirror_flush(&frame, pixels);
#if ALOOK_TOUCH_USB_MIRROR
    mirror_ms = millis() - mirror_started;
    const auto panel_started = millis();
#endif
    dirty_top = std::max(0, dirty_top & ~1); dirty_bottom = std::min(LCD_HEIGHT - 1, dirty_bottom | 1);
    display.draw16bitRGBBitmap(0, dirty_top, &pixels[dirty_top * LCD_WIDTH].full, LCD_WIDTH, dirty_bottom - dirty_top + 1);
    dirty_top = LCD_HEIGHT; dirty_bottom = -1;
#if ALOOK_TOUCH_USB_MIRROR
    panel_ms = millis() - panel_started;
#endif
  }
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
  constexpr size_t pixel_count = LCD_WIDTH * LCD_HEIGHT;
  auto* pixels = static_cast<lv_color_t*>(heap_caps_malloc(pixel_count * sizeof(lv_color_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
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
  driver.direct_mode = 1;
#if ALOOK_TOUCH_USB_MIRROR
  driver.monitor_cb = [](lv_disp_drv_t*, uint32_t elapsed, uint32_t pixels) { usb_mirror_display(millis() - refresh_started_at, pixels, elapsed, panel_ms, mirror_ms); };
#endif
  lv_disp_drv_register(&driver);
#if ALOOK_TOUCH_USB_MIRROR
  auto* context = lv_disp_get_default()->driver->draw_ctx;
  software_image = context->draw_img_decoded; context->draw_img_decoded = profile_image;
  auto* source = static_cast<lv_color_t*>(heap_caps_malloc(pixel_count * sizeof(lv_color_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (source) {
    const auto fill_started = usb_mirror_micros();
    std::memset(source, 0x5a, pixel_count * sizeof(lv_color_t));
    usb_mirror_profile(PsramFillUs, usb_mirror_micros() - fill_started);
    const auto copy_started = usb_mirror_micros();
    std::memcpy(pixels, source, pixel_count * sizeof(lv_color_t));
    usb_mirror_profile(PsramCopyUs, usb_mirror_micros() - copy_started);
    heap_caps_free(source);
  }
#endif
  static lv_indev_drv_t input;
  lv_indev_drv_init(&input);
  input.type = LV_INDEV_TYPE_POINTER;
  input.read_cb = read_touch;
  lv_indev_drv_register(&input);
  return true;
}

void board_tick() {
  usb_mirror_tick();
  refresh_started_at = millis();
#if ALOOK_TOUCH_USB_MIRROR
  image_draw_us = image_draw_calls = image_fast_calls = 0;
#endif
  lv_timer_handler();
#if ALOOK_TOUCH_USB_MIRROR
  if (image_draw_calls) {
    usb_mirror_profile(ImageDrawUs, image_draw_us); usb_mirror_profile(ImageDrawCalls, image_draw_calls); usb_mirror_profile(ImageFastCalls, image_fast_calls);
  }
#endif
}

bool board_present(const lv_img_dsc_t* frame) {
  if (!frame || !frame->data || frame->header.cf != LV_IMG_CF_TRUE_COLOR || frame->header.w != LCD_WIDTH || frame->header.h != LCD_HEIGHT || frame->data_size != LCD_WIDTH * LCD_HEIGHT * sizeof(lv_color_t)) return false;
  const lv_area_t area = {0, 0, LCD_WIDTH - 1, LCD_HEIGHT - 1};
  const auto* pixels = reinterpret_cast<const lv_color_t*>(frame->data);
#if ALOOK_TOUCH_USB_MIRROR
  const auto started = millis();
#endif
  usb_mirror_flush(&area, pixels);
#if ALOOK_TOUCH_USB_MIRROR
  const auto panel_started = millis();
#endif
  const bool presented = display.draw16bitRGBBitmap(0, 0, reinterpret_cast<const uint16_t*>(frame->data), LCD_WIDTH, LCD_HEIGHT);
#if ALOOK_TOUCH_USB_MIRROR
  const auto panel_elapsed = millis() - panel_started;
  usb_mirror_display(millis() - started, LCD_WIDTH * LCD_HEIGHT, millis() - started, panel_elapsed, panel_started - started);
  usb_mirror_profile(ImageDrawUs, 0); usb_mirror_profile(ImageDrawCalls, 0); usb_mirror_profile(ImageFastCalls, 0);
#endif
  return presented;
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
