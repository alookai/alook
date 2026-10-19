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
enum UsbMirrorProfileField : size_t { TemporalUs, PhotoUs, HaloUs, UpscaleUs, MaskUs, ImageDrawUs, PsramCopyUs, ImageDrawCalls, ImageFastCalls, PsramFillUs };
#if ALOOK_TOUCH_USB_MIRROR && defined(ESP_PLATFORM)
uint32_t usb_mirror_micros();
void usb_mirror_profile(UsbMirrorProfileField field, uint32_t value);
#else
inline uint32_t usb_mirror_micros() { return 0; }
inline void usb_mirror_profile(UsbMirrorProfileField, uint32_t) {}
#endif
#if ALOOK_TOUCH_USB_MIRROR
bool usb_mirror_begin();
void usb_mirror_flush(const lv_area_t* area, const lv_color_t* pixels);
void usb_mirror_tick();
bool usb_mirror_pointer(lv_indev_data_t* data);
bool usb_mirror_record();
bool usb_mirror_home();
void usb_mirror_http(const UsbMirrorHttpDiagnostic& diagnostic);
void usb_mirror_display(uint32_t elapsed, uint32_t pixels, uint32_t refresh, uint32_t panel, uint32_t mirror);
void usb_mirror_work(bool decode, uint32_t elapsed);
void usb_mirror_render(uint32_t elapsed, uint32_t body);
#else
inline bool usb_mirror_begin() { return true; }
inline void usb_mirror_flush(const lv_area_t*, const lv_color_t*) {}
inline void usb_mirror_tick() {}
inline bool usb_mirror_pointer(lv_indev_data_t*) { return false; }
inline bool usb_mirror_record() { return false; }
inline bool usb_mirror_home() { return false; }
inline void usb_mirror_http(const UsbMirrorHttpDiagnostic&) {}
inline void usb_mirror_display(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t) {}
inline void usb_mirror_work(bool, uint32_t) {}
inline void usb_mirror_render(uint32_t, uint32_t) {}
#endif
}
