#include "ui.h"

namespace alook_touch {
bool Ui::show_dm_page(const Interaction& state, const UiData& data) {
  if (state.page != Page::DmList) return false;
  base("Direct messages");
  auto* list = lv_obj_create(screen_);
  lv_obj_set_size(list, 326, 294);
  lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 94);
  lv_obj_set_style_bg_opa(list, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(list, 0, 0);
  lv_obj_set_style_pad_all(list, 8, 0);
  lv_obj_set_style_pad_row(list, 12, 0);
  lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
  if (!data.dm_error.empty()) {
    auto* failure = label(list, data.dm_error, 290);
    lv_obj_set_style_text_color(failure, lv_color_hex(0xfca3f7), 0);
  }
  if (data.dm_error.empty()) {
    if (!data.dms_loaded) label(list, "Loading...", 290);
    else if (data.dms.empty()) label(list, "No direct messages yet", 290);
  }
  for (size_t i = 0; i < data.dms.size(); ++i) {
    const auto& dm = data.dms[i];
    auto* row = button(list, dm.handle, Action::OpenDm, static_cast<int>(i));
    lv_obj_set_size(row, 306, 80);
    lv_obj_set_style_border_width(row, 1, 0);
    lv_obj_set_style_border_color(row, lv_color_hex(dm.id == data.dm_id ? 0xfbd975 : 0x343434), 0);
    auto* name = lv_obj_get_child(row, 0);
    lv_obj_set_width(name, 260); lv_obj_set_height(name, 30);
    lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(name, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(name, lv_color_white(), 0);
    lv_obj_align(name, LV_ALIGN_TOP_LEFT, 0, 0);
    auto* preview = label(row, dm.preview.empty() ? "" : dm.preview, 260);
    lv_obj_set_style_text_font(preview, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(preview, lv_color_hex(0xa4a7a4), 0);
    lv_label_set_long_mode(preview, LV_LABEL_LONG_DOT);
    lv_obj_set_height(preview, 22);
    lv_obj_align(preview, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    if (dm.unread) {
      auto* unread = lv_obj_create(row); lv_obj_remove_style_all(unread);
      lv_obj_set_size(unread, 8, 8); lv_obj_set_style_radius(unread, LV_RADIUS_CIRCLE, 0);
      lv_obj_set_style_bg_opa(unread, LV_OPA_COVER, 0);
      lv_obj_set_style_bg_color(unread, lv_color_hex(0x7edbb0), 0);
      lv_obj_align(unread, LV_ALIGN_RIGHT_MID, 0, 0);
    }
  }
  auto* reload = icon_button(screen_, LV_SYMBOL_REFRESH, Action::Dms);
  lv_obj_align(reload, LV_ALIGN_BOTTOM_MID, 0, -18);
  return true;
}
}
