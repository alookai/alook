#pragma once
#include "configuration.h"
#include <lvgl.h>

#ifndef ALOOK_TOUCH_USB_MIRROR
#define ALOOK_TOUCH_USB_MIRROR 0
#endif

namespace alook_touch {
#if ALOOK_TOUCH_USB_MIRROR
bool usb_mirror_begin();
void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels);
void usb_mirror_tick();
bool usb_mirror_pointer(lv_indev_data_t* data);
bool usb_mirror_record();
bool usb_mirror_home();
#else
inline bool usb_mirror_begin() { return true; }
inline void usb_mirror_flush(const lv_area_t*, const lv_color_t*) {}
inline void usb_mirror_tick() {}
inline bool usb_mirror_pointer(lv_indev_data_t*) { return false; }
inline bool usb_mirror_record() { return false; }
inline bool usb_mirror_home() { return false; }
#endif
}
