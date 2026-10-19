#pragma once
#include <lvgl.h>
void preview_board_flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* source, lv_color_t* panel);
bool preview_board_present(const lv_img_dsc_t* frame, lv_color_t* panel);
extern int preview_panel_calls, preview_panel_y, preview_panel_height;
