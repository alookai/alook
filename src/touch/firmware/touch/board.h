#pragma once
#include <Arduino.h>
#include <lvgl.h>

namespace alook_touch {
struct ButtonEvents { bool record_pressed; bool record_released; bool home; };
bool board_begin();
void board_tick();
bool board_present(const lv_img_dsc_t* frame);
ButtonEvents board_buttons();
int board_battery();
bool board_charging();
void board_brightness(uint8_t value);
}
