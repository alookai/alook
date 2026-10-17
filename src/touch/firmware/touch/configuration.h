#pragma once
#include <cstddef>
#if __has_include("configuration.local.h")
#include "configuration.local.h"
#endif
#ifndef ALOOK_TOUCH_ORIGIN
#define ALOOK_TOUCH_ORIGIN "https://alook.ai"
#endif
#ifndef ALOOK_TOUCH_ALLOW_HTTP
#define ALOOK_TOUCH_ALLOW_HTTP 0
#endif

namespace alook_touch {
inline constexpr const char* origin = ALOOK_TOUCH_ORIGIN;
inline constexpr const char* client_id = "alook-touch";
inline constexpr unsigned audio_sample_rate = 16000;
inline constexpr size_t audio_max_samples = audio_sample_rate * 60;
}
