#ifndef LV_CONF_H
#define LV_CONF_H
#define LV_COLOR_DEPTH 16
#define LV_COLOR_16_SWAP 0
#ifdef ESP_PLATFORM
#define LV_TICK_CUSTOM 1
#define LV_TICK_CUSTOM_INCLUDE <esp_timer.h>
#define LV_TICK_CUSTOM_SYS_TIME_EXPR (esp_timer_get_time() / 1000)
#endif
#define LV_USE_LARGE_COORD 1
#define LV_MEMCPY_MEMSET_STD 1
#define LV_MEM_CUSTOM 1
#define LV_MEM_CUSTOM_INCLUDE <esp_heap_caps.h>
#define LV_MEM_CUSTOM_ALLOC(size) heap_caps_malloc((size), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define LV_MEM_CUSTOM_FREE free
#define LV_MEM_CUSTOM_REALLOC(pointer, size) heap_caps_realloc((pointer), (size), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define LV_DISP_DEF_REFR_PERIOD 1
#define LV_INDEV_DEF_READ_PERIOD 20
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_MONTSERRAT_24 1
#define LV_FONT_MONTSERRAT_32 1
#define LV_FONT_DEFAULT &lv_font_montserrat_20
#define LV_FONT_SIMSUN_16_CJK 1
#define LV_FONT_FMT_TXT_LARGE 1
#define LV_USE_FONT_COMPRESSED 1
#define LV_USE_CANVAS 1
#define LV_USE_SNAPSHOT 1
#define LV_USE_PNG 1
#define LV_USE_QRCODE 1
#define LV_USE_DEMO_WIDGETS 0
#define LV_USE_DEMO_MUSIC 0
#define LV_USE_DEMO_BENCHMARK 0
#define LV_USE_DEMO_STRESS 0
#endif
