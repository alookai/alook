#pragma once
#include "configuration.h"
#include <lvgl.h>

#ifndef ALOOK_TOUCH_USB_MIRROR
#define ALOOK_TOUCH_USB_MIRROR 0
#endif

namespace alook_touch {
struct UsbMirrorHttpDiagnostic {
  uint32_t operation;
  int32_t error, status;
  uint32_t bytes, elapsed;
  int32_t socket_errno;
  uint32_t stage;
  uint32_t target_address = 0, target_port = 0;
  int32_t system_errno = 0, tls_error = 0, tls_flags = 0, tls_code = 0, socket = -1;
};
#if ALOOK_TOUCH_USB_MIRROR
bool usb_mirror_begin();
void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels);
void usb_mirror_tick();
bool usb_mirror_pointer(lv_indev_data_t* data);
bool usb_mirror_record();
bool usb_mirror_home();
void usb_mirror_http(const UsbMirrorHttpDiagnostic& diagnostic);
#else
inline bool usb_mirror_begin() { return true; }
inline void usb_mirror_flush(const lv_area_t*, const lv_color_t*) {}
inline void usb_mirror_tick() {}
inline bool usb_mirror_pointer(lv_indev_data_t*) { return false; }
inline bool usb_mirror_record() { return false; }
inline bool usb_mirror_home() { return false; }
inline void usb_mirror_http(const UsbMirrorHttpDiagnostic&) {}
#endif
}
