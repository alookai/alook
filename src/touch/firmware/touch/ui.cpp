#include "ui.h"
#include "usb_mirror.h"
#include "generated/face_assets.h"
#include <algorithm>
#include <cmath>
#include <cstring>
extern "C" { LV_FONT_DECLARE(alook_font_cjk); LV_FONT_DECLARE(alook_font_ui_24); LV_FONT_DECLARE(alook_font_ui_32); }

namespace alook_touch {
namespace {
constexpr uint32_t background = 0x000000;
constexpr uint32_t foreground = 0xffffff;
constexpr uint32_t muted = 0xa4a7a4;
constexpr uint32_t accent = 0xfbd975;
constexpr float scale = 466.0f / 360.0f;
constexpr std::array<uint32_t, 4> pastels = {0xfbd975, 0xfca3f7, 0x9d97ed, 0x7edbb0};
lv_font_t text_font;
lv_font_t control_font;
lv_font_t heading_font;
}

void Ui::begin(std::function<void(Action, int)> handler) {
  handler_ = std::move(handler);
  text_font = lv_font_montserrat_20;
  text_font.fallback = &alook_font_cjk;
  control_font = alook_font_ui_24; control_font.fallback = &alook_font_cjk;
  heading_font = alook_font_ui_32; heading_font.fallback = &alook_font_cjk;
  glow_art_.make_halo(); speaker_.set_halo(glow_art_.image());
  lv_obj_add_event_cb(lv_scr_act(), [](lv_event_t* event) {
    auto* ui = static_cast<Ui*>(lv_event_get_user_data(event));
    auto* input = lv_indev_get_act();
    if (!input || !ui->handler_) return;
    const auto direction = lv_indev_get_gesture_dir(input);
    lv_indev_wait_release(input);
    if (ui->page_ != Page::Character) return;
    if (direction == LV_DIR_TOP) ui->handler_(Action::Chat, 0);
    else if (direction == LV_DIR_LEFT || direction == LV_DIR_RIGHT) ui->handler_(Action::AdjacentBot, direction == LV_DIR_LEFT ? 1 : -1);
  }, LV_EVENT_GESTURE, this);
}

lv_obj_t* Ui::label(lv_obj_t* parent, const std::string& text, int width) {
  auto* item = lv_label_create(parent);
  lv_obj_set_width(item, width);
  lv_label_set_long_mode(item, LV_LABEL_LONG_WRAP);
  lv_label_set_text(item, text.c_str());
  lv_obj_set_style_text_color(item, lv_color_hex(foreground), 0);
  lv_obj_set_style_text_font(item, &text_font, 0);
  return item;
}

void Ui::clicked(lv_event_t* event) {
  auto* binding = static_cast<Binding*>(lv_event_get_user_data(event));
  if (binding && binding->self->handler_) binding->self->handler_(binding->action, binding->argument);
}

lv_obj_t* Ui::button(lv_obj_t* parent, const std::string& text, Action action, int argument) {
  auto* item = lv_btn_create(parent);
  lv_obj_set_size(item, 300, 48);
  lv_obj_set_style_bg_opa(item, LV_OPA_TRANSP, 0);
  lv_obj_set_style_radius(item, 12, 0);
  lv_obj_set_style_border_width(item, 0, 0);
  lv_obj_set_style_shadow_width(item, 0, 0);
  auto* text_item = label(item, text, 276);
  lv_obj_set_style_text_font(text_item, &control_font, 0);
  lv_obj_set_style_text_color(text_item, lv_color_hex(muted), 0);
  lv_obj_set_style_text_align(text_item, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_center(text_item);
  bindings_.push_back({this, action, argument, item});
  auto& binding = bindings_.back();
  lv_obj_add_event_cb(item, clicked, LV_EVENT_CLICKED, &binding);
  return item;
}

std::vector<ControlLocation> Ui::controls() const {
  std::vector<ControlLocation> result;
  for (const auto& binding : bindings_) {
    if (!binding.object || !lv_obj_is_visible(binding.object)) continue;
    lv_area_t area;
    lv_obj_get_coords(binding.object, &area);
    bool disabled = false;
    for (auto* parent = binding.object; parent; parent = lv_obj_get_parent(parent)) {
      disabled = disabled || lv_obj_has_state(parent, LV_STATE_DISABLED);
      lv_area_t bounds;
      lv_obj_get_coords(parent, &bounds);
      area.x1 = std::max(area.x1, bounds.x1); area.y1 = std::max(area.y1, bounds.y1);
      area.x2 = std::min(area.x2, bounds.x2); area.y2 = std::min(area.y2, bounds.y2);
    }
    if (area.x2 < area.x1 || area.y2 < area.y1) continue;
    auto* text = lv_obj_check_type(binding.object, &lv_label_class) ? binding.object : lv_obj_get_child_cnt(binding.object) ? lv_obj_get_child(binding.object, 0) : nullptr;
    const std::string label = text && lv_obj_check_type(text, &lv_label_class) ? lv_label_get_text(text) : "";
    result.push_back({label, binding.action, binding.argument, area.x1, area.y1, area.x2 - area.x1 + 1, area.y2 - area.y1 + 1, disabled, binding.long_press});
  }
  return result;
}

lv_obj_t* Ui::icon_button(lv_obj_t* parent, const char* symbol, Action action) {
  auto* item = button(parent, symbol, action);
  lv_obj_set_size(item, 44, 44);
  auto* icon = lv_obj_get_child(item, 0);
  lv_obj_set_style_text_font(icon, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(icon, lv_color_white(), 0);
  lv_obj_set_width(icon, 28);
  return item;
}

void Ui::highlight(lv_obj_t* item, uint32_t color) {
  lv_obj_set_style_bg_opa(item, LV_OPA_COVER, 0);
  lv_obj_set_style_bg_color(item, lv_color_hex(color), 0);
  lv_obj_set_style_text_color(lv_obj_get_child(item, 0), lv_color_black(), 0);
  lv_point_t text_size{};
  lv_txt_get_size(&text_size, lv_label_get_text(lv_obj_get_child(item, 0)), &control_font, 0, 0, 276, LV_TEXT_FLAG_NONE);
  const lv_coord_t width = std::min<lv_coord_t>(300, text_size.x + 40);
  lv_obj_set_width(item, width);
  lv_obj_set_width(lv_obj_get_child(item, 0), width - 24);
}

void Ui::base(const std::string& heading) {
  screen_ = lv_scr_act();
  lv_obj_clean(screen_);
  history_ = latest_ = character_ = title_ = nullptr;
  notice_ = nullptr; notice_until_ = 0;
  user_scrolling_ = false; history_edge_ = 0;
  eyes_ = eye_clip_ = mouth_ = character_body_ = character_fallback_ = character_glow_ = nullptr;
  shown_character_ = nullptr; shown_seed_.clear(); eye_pixels_ = mouth_pixels_ = 0;
  bindings_.clear();
  bubbles_.fill(nullptr);
  lv_obj_set_style_bg_color(screen_, lv_color_hex(background), 0);
  lv_obj_set_style_bg_opa(screen_, LV_OPA_COVER, 0);
  lv_obj_clear_flag(screen_, LV_OBJ_FLAG_SCROLLABLE);
  title_ = label(screen_, heading, 320);
  lv_obj_set_style_text_font(title_, &heading_font, 0);
  lv_obj_set_style_text_align(title_, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(title_, LV_ALIGN_TOP_MID, 0, 42);
}

void Ui::qr(const std::string& content) {
  if (content.empty()) return;
  auto* code = lv_qrcode_create(screen_, 190, lv_color_black(), lv_color_white());
  lv_obj_set_style_border_width(code, 12, 0);
  lv_obj_set_style_border_color(code, lv_color_white(), 0);
  lv_obj_align(code, LV_ALIGN_CENTER, 0, -35);
  if (lv_qrcode_update(code, content.data(), content.size()) != LV_RES_OK) lv_obj_add_flag(code, LV_OBJ_FLAG_HIDDEN);
}

lv_obj_t* Ui::avatar(lv_obj_t* parent, AvatarArt& art, const lv_img_dsc_t* image, bool custom, int diameter) {
  auto* group = lv_obj_create(parent);
  lv_obj_remove_style_all(group);
  lv_obj_set_size(group, diameter, diameter);
  lv_obj_clear_flag(group, LV_OBJ_FLAG_SCROLLABLE);
  const auto* source = image ? image : custom ? nullptr : art.image();
  if (!source || !source->data) {
    auto* placeholder = label(group, "…", diameter);
    lv_obj_set_style_text_align(placeholder, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(placeholder);
    return group;
  }
  const auto put = [&](const lv_img_dsc_t* sprite, int x, int y) {
    auto* item = lv_img_create(group);
    lv_img_set_src(item, sprite);
    lv_img_set_pivot(item, 0, 0);
    lv_img_set_zoom(item, diameter * 256 / sprite->header.w);
    lv_obj_set_pos(item, x * diameter / 288, y * diameter / 288);
  };
  put(source, 0, 0);
  return group;
}

void Ui::show(const Interaction& state, const UiData& data) {
  if (page_ != state.page && !transition_image_ && !suppress_transition_) prepare_transition();
  suppress_transition_ = false;
  const bool reuse_character = page_ == Page::Character && state.page == Page::Character && character_;
  page_ = state.page;
  if (data.dm_enabled && show_dm_page(state, data)) return;
  switch (page_) {
    case Page::Startup: {
      base("");
      auto* logo = lv_img_create(screen_);
      lv_img_set_src(logo, &assets::logo);
      lv_obj_center(logo);
      break;
    }
    case Page::Network:
    case Page::Authorization: {
      base(page_ == Page::Network ? "Connect touch" : "Sign in to Alook");
      qr(data.qr);
      auto* status = label(screen_, data.error.empty() ? data.status : data.error, 310);
      lv_obj_set_style_text_align(status, LV_TEXT_ALIGN_CENTER, 0);
      if (!data.error.empty()) lv_obj_set_style_text_color(status, lv_color_hex(pastels[1]), 0);
      lv_obj_align(status, data.qr.empty() ? LV_ALIGN_CENTER : LV_ALIGN_TOP_MID, 0, data.qr.empty() ? -15 : 309);
      if (!data.short_code.empty()) {
        auto* code = label(screen_, data.short_code, 320);
        lv_obj_set_style_text_align(code, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(code, LV_ALIGN_TOP_MID, 0, 357);
      }
      const auto retry_action = page_ == Page::Network ? Action::SetupNetwork : Action::Authorize;
      auto* retry = data.qr.empty()
        ? button(screen_, page_ == Page::Network ? "Wi-Fi setup" : "Get a new code", retry_action)
        : icon_button(screen_, LV_SYMBOL_REFRESH, retry_action);
      if (data.qr.empty()) lv_obj_set_size(retry, 220, 44);
      lv_obj_align(retry, LV_ALIGN_TOP_MID, 0, 392);
      if (page_ == Page::Network && !data.qr.empty()) {
        auto* cancel = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Back);
        lv_obj_align(cancel, LV_ALIGN_BOTTOM_MID, 72, -30);
      }
      break;
    }
    case Page::Character: {
      if (!reuse_character) {
        base("");
        character_ = lv_obj_create(screen_); lv_obj_remove_style_all(character_); lv_obj_set_size(character_, 466, 466);
        lv_obj_set_style_radius(character_, LV_RADIUS_CIRCLE, 0); lv_obj_set_style_clip_corner(character_, false, 0);
        lv_obj_clear_flag(character_, LV_OBJ_FLAG_SCROLLABLE); lv_obj_center(character_);
        character_body_ = lv_img_create(character_);
        character_fallback_ = label(character_, "", 320);
        lv_obj_set_style_text_align(character_fallback_, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_style_text_font(character_fallback_, &heading_font, 0);
        eye_clip_ = lv_obj_create(character_); lv_obj_remove_style_all(eye_clip_);
        lv_obj_clear_flag(eye_clip_, LV_OBJ_FLAG_SCROLLABLE);
        eyes_ = lv_img_create(eye_clip_); mouth_ = lv_img_create(character_);
        character_glow_ = lv_img_create(character_); lv_img_set_src(character_glow_, glow_art_.image());
        lv_obj_clear_flag(character_glow_, LV_OBJ_FLAG_CLICKABLE); lv_obj_center(character_glow_);
      }
      const auto visible = [](lv_obj_t* object, bool show) {
        const bool hidden = lv_obj_has_flag(object, LV_OBJ_FLAG_HIDDEN);
        if (show && hidden) lv_obj_clear_flag(object, LV_OBJ_FLAG_HIDDEN);
        else if (!show && !hidden) lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
      };
      generated_character_ = !image_ && !data.bot_custom;
      const bool available = generated_character_ ? speaker_.set_seed(seed_) : texture_ ? speaker_.set_texture(texture_) : false;
      speaker_.set_online(data.bot_online);
      const auto* source = available ? speaker_.image() : image_;
      const bool source_changed = source != shown_character_ || (generated_character_ && seed_ != shown_seed_);
      if (source && source_changed) {
        if (available) {
          const auto pose = idle_.at(lv_tick_get() / 1000.0f);
          speaker_.render(pose);
          if (generated_character_) {
            const auto& eyes = assets::eyes[art_.identity.eyes]; const auto& mouth = assets::mouth[art_.identity.mouth];
            speaker_.draw_face(eyes_art_.image(), eyes.x, eyes.y - 44, mouth_art_.image(), mouth.x, mouth.y - 44, pose, lv_tick_get() / 1000.0f);
          }
        }
        if (available) speaker_.finish_frame();
        lv_img_set_src(character_body_, source); lv_img_set_pivot(character_body_, 0, 0);
        lv_img_set_zoom(character_body_, 466 * 256 / source->header.w); lv_obj_set_pos(character_body_, 0, 0);
      }
      visible(character_body_, source && source->data);
      visible(eye_clip_, false); visible(mouth_, false);
      visible(character_fallback_, !source || !source->data);
      if (!source || !source->data) {
        const auto text = data.dm_enabled ? data.dm_handle : data.bot_name;
        if (text != lv_label_get_text(character_fallback_)) lv_label_set_text(character_fallback_, text.c_str());
        lv_obj_center(character_fallback_);
      }
      visible(character_glow_, data.bot_online && !available);
      shown_character_ = source; shown_seed_ = seed_;
      break;
    }
    case Page::Home: {
      base("");
      auto* me = button(screen_, "", Action::Profile);
      lv_obj_set_size(me, 200, 58);
      lv_obj_align(me, LV_ALIGN_TOP_MID, -34, 40);
      auto* person = avatar(me, human_art_, human_image_, data.human_custom, 40);
      lv_obj_align(person, LV_ALIGN_LEFT_MID, -4, 0);
      auto* name = lv_obj_get_child(me, 0);
      lv_label_set_text(name, data.human_name.c_str());
      lv_obj_set_style_text_color(name, lv_color_white(), 0);
      lv_obj_set_width(name, 130);
      lv_obj_align(name, LV_ALIGN_RIGHT_MID, 0, 0);
      auto* battery = lv_obj_create(screen_);
      lv_obj_remove_style_all(battery); lv_obj_set_size(battery, 40, 22); lv_obj_set_pos(battery, 296, 59);
      lv_obj_set_style_radius(battery, 4, 0); lv_obj_set_style_border_width(battery, 1, 0);
      lv_obj_set_style_border_color(battery, lv_color_hex(0xd2d2d2), 0);
      auto* nub = lv_obj_create(screen_); lv_obj_remove_style_all(nub);
      lv_obj_set_size(nub, 4, 10); lv_obj_set_pos(nub, 336, 65);
      lv_obj_set_style_bg_color(nub, lv_color_hex(0xd2d2d2), 0); lv_obj_set_style_bg_opa(nub, LV_OPA_COVER, 0);
      if (data.battery > 0) {
        auto* fill = lv_obj_create(battery); lv_obj_remove_style_all(fill);
        lv_obj_set_size(fill, std::clamp(data.battery, 0, 100) * 34 / 100, 16); lv_obj_set_pos(fill, 3, 3);
        lv_obj_set_style_bg_color(fill, lv_color_hex(data.battery > 50 ? 0x50dc78 : data.battery > 20 ? 0xffbe3c : 0xf05046), 0);
        lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
      }
      auto* percent = label(screen_, data.battery < 0 ? "--%" : std::to_string(std::clamp(data.battery, 0, 100)) + "%", 52);
      lv_obj_set_style_text_font(percent, &lv_font_montserrat_14, 0); lv_obj_set_pos(percent, 350, 62);
      if (data.charging) {
        auto* charge = label(screen_, LV_SYMBOL_CHARGE, 18); lv_obj_set_pos(charge, 277, 60);
        lv_obj_set_style_text_font(charge, &lv_font_montserrat_14, 0); lv_obj_set_style_text_color(charge, lv_color_hex(0xffd530), 0);
      }
      menu_.reset();
      const std::array<std::string, 3> names = {data.dm_enabled ? "DMs" : "Bots", "Profile", "More"};
      const std::array<Action, 3> actions = {data.dm_enabled ? Action::Dms : Action::Bots, Action::Profile, Action::Settings};
      const std::array<uint32_t, 3> colors = {pastels[0], pastels[1], pastels[3]};
      for (size_t i = 0; i < names.size(); ++i) {
        bubbles_[i] = button(screen_, names[i], actions[i]);
        lv_obj_set_style_radius(bubbles_[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(bubbles_[i], 3, 0);
        lv_obj_set_style_border_color(bubbles_[i], lv_color_hex(colors[i]), 0);
        auto* text = lv_obj_get_child(bubbles_[i], 0);
        lv_obj_set_style_text_font(text, &heading_font, 0);
        lv_obj_set_style_text_color(text, lv_color_hex(colors[i]), 0);
        if (i == static_cast<size_t>(menu_.focused)) highlight(bubbles_[i], colors[i]);
        lv_obj_clear_flag(bubbles_[i], LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(bubbles_[i], LV_OBJ_FLAG_ADV_HITTEST);
      }
      break;
    }
    case Page::Settings: {
      base("Settings");
      auto* info = label(screen_, data.status, 300);
      lv_obj_set_style_text_align(info, LV_TEXT_ALIGN_CENTER, 0);
      lv_obj_align(info, LV_ALIGN_TOP_MID, 0, 105);
      auto* network = button(screen_, "Wi-Fi setup", Action::SetupNetwork);
      highlight(network, pastels[3]);
      lv_obj_align(network, LV_ALIGN_CENTER, 0, -54);
      auto* bright = button(screen_, "Brightness", Action::Brightness);
      lv_obj_align(bright, LV_ALIGN_CENTER, 0, 4);
      auto* update = button(screen_, "Update", Action::Update);
      lv_obj_align(update, LV_ALIGN_CENTER, 0, 62);
      auto* logout = button(screen_, "Log out", Action::Logout);
      lv_obj_align(logout, LV_ALIGN_CENTER, 0, 120);
      break;
    }
    case Page::FirmwareUpdate: {
      base("Update");
      const auto text = [&](const std::string& value, int top) {
        auto* item = label(screen_, value, 300);
        lv_obj_set_style_text_align(item, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(item, LV_ALIGN_TOP_MID, 0, top);
        return item;
      };
      text("Current firmware\n" + (data.firmware_version.empty() ? std::string("Unknown") : data.firmware_version), 108);
      std::string status;
      switch (data.update_phase) {
        case UpdatePhase::Idle: status = "Not checked"; break;
        case UpdatePhase::Checking: status = "Checking for updates..."; break;
        case UpdatePhase::Current: status = "Up to date"; break;
        case UpdatePhase::Available: status = "Available: " + data.available_version; break;
        case UpdatePhase::CheckFailed: status = "Could not check for updates"; break;
        case UpdatePhase::Installing: status = data.update_progress < 0 ? "Updating..." : "Updating...\n" + std::to_string(data.update_progress) + "%"; break;
        case UpdatePhase::Restarting: status = "Update installed\nRestarting..."; break;
        case UpdatePhase::InstallFailed: status = "Update failed"; break;
      }
      text(status, 210);
      if (!data.update_error.empty()) {
        auto* error = text(data.update_error, 256);
        lv_obj_set_style_text_color(error, lv_color_hex(pastels[1]), 0);
        lv_obj_set_style_text_font(error, &lv_font_montserrat_16, 0);
      }
      const bool busy = data.update_phase == UpdatePhase::Installing || data.update_phase == UpdatePhase::Restarting;
      if (!busy) {
        const bool available = data.update_phase == UpdatePhase::Available;
        auto* check = button(screen_, data.update_phase == UpdatePhase::Checking ? "Checking..." : available ? "Update now" : "Check for update", available ? Action::InstallUpdate : Action::CheckUpdate);
        highlight(check, pastels[0]);
        lv_obj_align(check, LV_ALIGN_TOP_MID, 0, 324);
        if (data.update_phase == UpdatePhase::Checking) lv_obj_add_state(check, LV_STATE_DISABLED);
      }
      auto* close = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Settings);
      lv_obj_align(close, LV_ALIGN_BOTTOM_MID, 0, -10);
      if (busy) lv_obj_add_state(close, LV_STATE_DISABLED);
      break;
    }
    case Page::Profile: {
      if (!state.profile_requests_only && !data.peer_name.empty()) {
        base("");
        auto* person = avatar(screen_, peer_art_, peer_image_, data.peer_custom, 466);
        lv_obj_center(person);
        auto* name = label(screen_, data.peer_handle.empty() ? data.peer_name : data.peer_handle, 300);
        lv_obj_set_style_text_align(name, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_style_text_font(name, &control_font, 0);
        lv_obj_align(name, LV_ALIGN_BOTTOM_MID, 0, -120);
        const bool checking = data.peer_state == "Checking friendship…";
        const bool waiting = data.peer_state == "outgoing";
        const bool friends = data.peer_state == "friends";
        const bool incoming = data.peer_state == "incoming";
        const bool gated = data.peer_state == "owner_approval";
        auto* add = button(screen_, checking ? "Checking..." : gated ? "Waiting for owner" : waiting ? "Request sent" : friends ? "Already friends" : incoming ? "Accept request" : "Add friend", incoming ? Action::AcceptFriend : Action::AddFriend);
        highlight(add, pastels[2]);
        lv_obj_align(add, LV_ALIGN_BOTTOM_MID, 0, -60);
        if (checking || waiting || friends || gated) lv_obj_add_state(add, LV_STATE_DISABLED);
        auto* back = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Requests);
        lv_obj_align(back, LV_ALIGN_BOTTOM_MID, 0, -10);
        if (!data.error.empty()) {
          auto* notice = lv_obj_create(screen_);
          lv_obj_set_size(notice, 300, LV_SIZE_CONTENT);
          lv_obj_set_style_min_height(notice, 72, 0);
          lv_obj_set_style_max_height(notice, 132, 0);
          lv_obj_set_style_pad_all(notice, 12, 0);
          lv_obj_align(notice, LV_ALIGN_TOP_MID, 0, 76);
          lv_obj_set_style_bg_color(notice, lv_color_black(), 0);
          lv_obj_set_style_bg_opa(notice, 230, 0);
          lv_obj_set_style_border_color(notice, lv_color_hex(pastels[1]), 0);
          lv_obj_set_style_border_width(notice, 1, 0);
          lv_obj_set_style_radius(notice, 16, 0);
          lv_obj_set_scroll_dir(notice, LV_DIR_VER);
          auto* error = label(notice, data.error, 274);
          lv_obj_set_style_text_color(error, lv_color_hex(pastels[1]), 0);
          lv_obj_set_style_text_align(error, LV_TEXT_ALIGN_CENTER, 0);
        }
      } else {
        base("My profile");
        auto* person = avatar(screen_, human_art_, human_image_, data.human_custom, 56);
        lv_obj_align(person, LV_ALIGN_TOP_MID, -104, 96);
        auto* identity = label(screen_, data.human_handle, 214);
        lv_obj_set_style_text_font(identity, &control_font, 0);
        lv_obj_align(identity, LV_ALIGN_TOP_MID, 48, 108);
        auto* heading = label(screen_, "Friend requests", 320);
        lv_obj_set_style_text_font(heading, &control_font, 0);
        lv_obj_set_style_text_align(heading, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(heading, LV_ALIGN_TOP_MID, 0, 173);
        auto* list = lv_obj_create(screen_);
        lv_obj_set_size(list, 326, 203);
        lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 211);
        lv_obj_set_style_bg_opa(list, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(list, 0, 0);
        lv_obj_set_style_pad_all(list, 8, 0);
        lv_obj_set_style_pad_row(list, 10, 0);
        lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
        const auto& failure = data.requests_error.empty() ? data.error : data.requests_error;
        if (!failure.empty()) {
          auto* error = label(list, failure, 288);
          lv_obj_set_style_text_color(error, lv_color_hex(pastels[1]), 0);
        }
        const auto incoming_count = std::count_if(data.requests.begin(), data.requests.end(), [](const FriendRequestItem& item) { return item.kind == "incoming"; });
        if (failure.empty() && !data.requests_loaded) label(list, "Loading requests...", 288);
        else if (failure.empty() && !incoming_count) label(list, "No friend requests", 288);
        for (size_t i = 0; i < data.requests.size(); ++i) {
          const auto& request = data.requests[i];
          if (request.kind != "incoming") continue;
          auto* row = lv_obj_create(list);
          lv_obj_set_size(row, 306, request.needs_owner_approval ? 86 : 64);
          lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
          lv_obj_set_style_border_width(row, 1, 0);
          lv_obj_set_style_border_color(row, lv_color_hex(0x343434), 0);
          lv_obj_set_style_radius(row, 12, 0);
          lv_obj_set_style_pad_all(row, 8, 0);
          lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
          auto* name = label(row, request.name, 182);
          lv_obj_set_style_text_font(name, &control_font, 0);
          lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
          lv_obj_set_height(name, 28);
          lv_obj_align(name, request.needs_owner_approval ? LV_ALIGN_TOP_LEFT : LV_ALIGN_LEFT_MID, 0, 0);
          if (request.needs_owner_approval) {
            auto* status = label(row, "Waiting for owner approval", 280);
            lv_obj_set_style_text_font(status, &lv_font_montserrat_14, 0);
            lv_obj_set_style_text_color(status, lv_color_hex(muted), 0);
            lv_obj_align(status, LV_ALIGN_TOP_LEFT, 0, 36);
          }
          if (request.kind == "incoming") {
            auto* accept = button(row, data.request_busy == request.id ? "..." : "Accept", Action::AcceptRequest, static_cast<int>(i));
            highlight(accept, pastels[3]);
            lv_obj_set_size(accept, 82, 44);
            auto* text = lv_obj_get_child(accept, 0);
            lv_obj_set_style_text_font(text, &lv_font_montserrat_16, 0);
            lv_obj_set_width(text, 72);
            lv_obj_align(accept, LV_ALIGN_TOP_RIGHT, 0, 0);
            if (!data.request_busy.empty() || request.needs_owner_approval) lv_obj_add_state(accept, LV_STATE_DISABLED);
          }
        }
      }
      break;
    }
    case Page::Bots: {
      base(data.bots_loaded ? "No BOTs yet" : "Loading BOTs...");
      if (data.bots_loaded) {
        auto* info = label(screen_, "Create a BOT on your phone.", 290);
        lv_obj_set_style_text_align(info, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(info, LV_ALIGN_CENTER, 0, -30);
        auto* reload = button(screen_, "Reload BOTs", Action::Bots);
        highlight(reload, pastels[0]);
        lv_obj_align(reload, LV_ALIGN_TOP_MID, 0, 300);
      }
      break;
    }
    case Page::Conversation: {
      base(data.dm_enabled ? data.dm_handle : data.bot_name);
      if (data.dm_enabled) {
        lv_obj_set_height(title_, 40);
        lv_label_set_long_mode(title_, LV_LABEL_LONG_SCROLL_CIRCULAR);
      }
      lv_obj_set_size(title_, 320, 88);
      lv_obj_align(title_, LV_ALIGN_TOP_MID, 0, 0);
      lv_obj_set_style_pad_top(title_, 42, 0);
      lv_obj_add_flag(title_, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_PRESS_LOCK);
      lv_obj_clear_flag(title_, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
      lv_obj_add_event_cb(title_, [](lv_event_t* event) {
        auto* ui = static_cast<Ui*>(lv_event_get_user_data(event));
        auto* input = lv_indev_get_act();
        if (!input || lv_indev_get_gesture_dir(input) != LV_DIR_BOTTOM || !ui->handler_) return;
        lv_indev_wait_release(input); lv_event_stop_bubbling(event);
        ui->handler_(Action::Back, 0);
      }, LV_EVENT_GESTURE, this);
      const bool cannot_read = data.dm_enabled && !data.dm_can_read;
      const bool cannot_send = data.dm_enabled && !data.dm_can_send;
      history_ = lv_obj_create(screen_);
      lv_obj_set_size(history_, 326, cannot_send ? 288 : 312);
      lv_obj_align(history_, LV_ALIGN_TOP_MID, 0, cannot_send ? 112 : 88);
      lv_obj_set_style_bg_opa(history_, LV_OPA_TRANSP, 0);
      lv_obj_set_style_border_width(history_, 0, 0);
      lv_obj_set_flex_flow(history_, LV_FLEX_FLOW_COLUMN);
      lv_obj_set_style_pad_row(history_, 16, 0);
      message_ids_.clear();
      if (!cannot_read) for (const auto& message : data.messages) {
        message_ids_.push_back(message.id);
        auto* body = label(history_, message.author + "\n" + message.text, 292);
        lv_obj_set_style_text_color(body, lv_color_hex(message.own ? accent : foreground), 0);
      }
      if (cannot_read) label(history_, "You can no longer read this DM", 280);
      else if (data.messages.empty()) label(history_, data.status.empty() ? "Hold BOOT to talk" : data.status, 280);
      if (cannot_send && !cannot_read) {
        auto* warning = label(screen_, "This DM cannot send", 300);
        lv_obj_set_style_text_font(warning, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_align(warning, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(warning, LV_ALIGN_TOP_MID, 0, 88);
      }
      history_has_older_ = !cannot_read && data.has_older;
      history_has_newer_ = !cannot_read && data.has_newer;
      latest_ = button(screen_, LV_SYMBOL_DOWN, Action::Latest);
      lv_obj_set_size(latest_, 48, 48);
      lv_obj_align(latest_, LV_ALIGN_BOTTOM_MID, 0, -20);
      lv_obj_set_style_radius(latest_, LV_RADIUS_CIRCLE, 0);
      lv_obj_set_style_bg_color(latest_, lv_color_hex(pastels[3]), 0);
      lv_obj_set_style_bg_opa(latest_, LV_OPA_COVER, 0);
      auto* arrow = lv_obj_get_child(latest_, 0);
      lv_obj_set_width(arrow, 28);
      lv_obj_set_style_text_font(arrow, &lv_font_montserrat_24, 0);
      lv_obj_set_style_text_color(arrow, lv_color_black(), 0);
      lv_obj_update_layout(history_);
      lv_obj_scroll_to_y(history_, lv_obj_get_scroll_bottom(history_), LV_ANIM_OFF);
      lv_obj_add_event_cb(history_, history_scrolled, LV_EVENT_ALL, this);
      update_history_arrow();
      break;
    }
    case Page::RecordReady:
    case Page::Recording:
    case Page::Transcribing: {
      base(data.dm_enabled ? data.dm_handle : data.bot_name);
      if (data.dm_enabled) {
        lv_obj_set_height(title_, 40);
        lv_label_set_long_mode(title_, LV_LABEL_LONG_SCROLL_CIRCULAR);
      }
      auto* status = label(screen_, page_ == Page::RecordReady ? "Hold BOOT to record" : page_ == Page::Recording ? "Recording\nRelease BOOT to transcribe" : "Transcribing...", 310);
      lv_obj_set_style_text_align(status, LV_TEXT_ALIGN_CENTER, 0);
      lv_obj_set_style_text_font(status, &control_font, 0);
      lv_obj_set_style_text_color(status, lv_color_hex(page_ == Page::Recording ? pastels[1] : foreground), 0);
      lv_obj_center(status);
      auto* cancel = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Cancel);
      lv_obj_align(cancel, LV_ALIGN_BOTTOM_MID, 0, -10);
      break;
    }
    case Page::Review: {
      base("To " + (data.dm_enabled ? data.dm_handle : data.bot_name));
      if (data.dm_enabled) {
        lv_obj_set_height(title_, 40);
        lv_label_set_long_mode(title_, LV_LABEL_LONG_SCROLL_CIRCULAR);
      }
      auto* panel = lv_obj_create(screen_);
      lv_obj_set_size(panel, 320, 188);
      lv_obj_align(panel, LV_ALIGN_TOP_MID, 0, 94);
      lv_obj_set_style_bg_color(panel, lv_color_hex(0x000000), 0);
      lv_obj_set_style_border_width(panel, 0, 0);
      lv_obj_set_flex_flow(panel, LV_FLEX_FLOW_COLUMN);
      lv_obj_set_style_pad_row(panel, 8, 0);
      if (!state.draft.empty() && !data.error.empty()) {
        auto* error = label(panel, data.error, 284);
        lv_obj_set_style_text_color(error, lv_color_hex(pastels[1]), 0);
      }
      label(panel, state.draft.empty() ? data.error : state.draft, 284);
      const bool failed = state.voice == VoicePhase::Failed && !state.nonce.empty();
      auto* send = button(screen_, state.voice == VoicePhase::Sending ? "Sending..." : failed ? "Retry message" : "Send message", failed ? Action::Retry : Action::Send);
      highlight(send, pastels[0]);
      lv_obj_align(send, LV_ALIGN_TOP_MID, 0, 300);
      if (state.voice == VoicePhase::Sending || state.draft.empty() || (data.dm_enabled && (!data.dm_can_read || !data.dm_can_send))) lv_obj_add_state(send, LV_STATE_DISABLED);
      auto* again = icon_button(screen_, LV_SYMBOL_REFRESH, Action::Rerecord);
      lv_obj_align(again, LV_ALIGN_TOP_MID, -42, 372);
      auto* cancel = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Cancel);
      lv_obj_align(cancel, LV_ALIGN_TOP_MID, 42, 372);
      if (state.voice == VoicePhase::Sending) { lv_obj_add_state(again, LV_STATE_DISABLED); lv_obj_add_state(cancel, LV_STATE_DISABLED); }
      break;
    }
    case Page::LogoutConfirmation: {
      base("Log out of Alook?");
      auto* explanation = label(screen_, "Clear this account and private content.\nKeep Wi-Fi connected.", 300);
      lv_obj_set_style_text_align(explanation, LV_TEXT_ALIGN_CENTER, 0);
      lv_obj_align(explanation, LV_ALIGN_CENTER, 0, -40);
      auto* confirm = button(screen_, "Log out", Action::ConfirmLogout);
      highlight(confirm, pastels[1]);
      lv_obj_align(confirm, LV_ALIGN_CENTER, 0, 54);
      auto* back = icon_button(screen_, LV_SYMBOL_CLOSE, Action::Back);
      lv_obj_align(back, LV_ALIGN_TOP_MID, 0, 323);
      break;
    }
  }
  if (!data.error.empty() && page_ != Page::Review && page_ != Page::Character && page_ != Page::Authorization && page_ != Page::Network && page_ != Page::Profile) {
    auto* error = label(screen_, data.error, 308);
    lv_obj_set_style_text_color(error, lv_color_hex(0xeb9d8b), 0);
    lv_obj_set_style_text_align(error, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(error, LV_ALIGN_BOTTOM_MID, 0, -58);
  }
}

void Ui::tick(uint32_t now) {
  if (now == last_frame_) return;
  const float dt = (now - last_frame_) / 1000.0f;
  last_frame_ = now;
  if (transition_image_ && !transition_started_) {
    lv_anim_refr_now();
    transition_started_ = true;
    lv_obj_fade_out(transition_image_, 300, 0);
    if (auto* animation = lv_anim_get(transition_image_, nullptr)) {
      lv_anim_set_user_data(animation, this);
      lv_anim_set_ready_cb(animation, [](lv_anim_t* value) { static_cast<Ui*>(value->user_data)->clear_transition(); });
    } else clear_transition();
  }
  if (notice_ && static_cast<int32_t>(lv_tick_get() - notice_until_) >= 0) { lv_obj_del(notice_); notice_ = nullptr; }
  if (page_ == Page::Conversation) {
    update_history_arrow();
    if (history_edge_ && handler_) {
      const auto action = history_edge_ < 0 ? Action::Older : Action::Newer;
      history_edge_ = 0;
      handler_(action, 0);
    }
  } else if (page_ == Page::Home) {
    menu_.step(dt);
    for (size_t i = 0; i < bubbles_.size(); ++i) if (bubbles_[i]) {
      const auto& bubble = menu_.bubbles[i];
      const int size = static_cast<int>(bubble.radius * 2 * scale);
      lv_obj_set_size(bubbles_[i], size, size);
      lv_obj_set_pos(bubbles_[i], static_cast<int>((bubble.x - bubble.radius) * scale), static_cast<int>((bubble.y - bubble.radius) * scale));
      auto* text = lv_obj_get_child(bubbles_[i], 0);
      lv_obj_set_width(text, std::max(44, size - 16));
      lv_obj_center(text);
    }
  } else if (page_ == Page::Character && character_) {
    if (generated_character_ || texture_) {
      const auto render_started = lv_tick_get();
      const auto pose = idle_.at(now / 1000.0f);
      if (speaker_.render(pose)) {
        const auto body_elapsed = lv_tick_get() - render_started;
        if (generated_character_) {
          const auto& eyes = assets::eyes[art_.identity.eyes]; const auto& mouth = assets::mouth[art_.identity.mouth];
          speaker_.draw_face(eyes_art_.image(), eyes.x, eyes.y - 44, mouth_art_.image(), mouth.x, mouth.y - 44, pose, now / 1000.0f);
        }
        speaker_.finish_frame();
        if (!direct_frame()) lv_obj_invalidate(character_body_);
        usb_mirror_render(lv_tick_get() - render_started, body_elapsed);
      }
    }
  }
}

const lv_img_dsc_t* Ui::direct_frame() const {
  const auto* image = speaker_.image();
  return direct_character_enabled_ && page_ == Page::Character && !transition_image_ && !notice_ && (generated_character_ || texture_) && shown_character_ == image && image->data ? image : nullptr;
}

void Ui::set_character(const lv_img_dsc_t* image, const uint8_t* texture) {
  if ((image_ != image || texture_ != texture) && image_ && character_body_) {
    lv_img_set_src(character_body_, nullptr); shown_character_ = nullptr;
  }
  if (image_ != image || texture_ != texture) speaker_.reset_source();
  image_ = image; texture_ = texture;
}
void Ui::clear_transition() {
  if (transition_image_) { lv_obj_del(transition_image_); transition_image_ = nullptr; }
  if (transition_snapshot_) {
    lv_img_cache_invalidate_src(transition_snapshot_);
    lv_snapshot_free(transition_snapshot_); transition_snapshot_ = nullptr;
  }
}
void Ui::retire_session() {
  clear_transition();
  suppress_transition_ = true;
}
void Ui::prepare_transition() {
  const auto* current = direct_frame();
  clear_transition();
  if (!screen_) return;
  auto* display = lv_obj_get_disp(screen_);
  auto* buffer = lv_disp_get_draw_buf(display);
  const auto width = lv_disp_get_hor_res(display), height = lv_disp_get_ver_res(display);
  if (display->driver->direct_mode && !buffer->buf2 && buffer->size == static_cast<uint32_t>(width * height)) {
    auto* image = static_cast<lv_img_dsc_t*>(lv_mem_alloc(sizeof(lv_img_dsc_t)));
    auto* pixels = static_cast<uint8_t*>(lv_mem_alloc(buffer->size * sizeof(lv_color_t)));
    if (image && pixels) {
      *image = {};
      image->header.cf = LV_IMG_CF_TRUE_COLOR; image->header.w = width; image->header.h = height;
      image->data_size = buffer->size * sizeof(lv_color_t); image->data = pixels;
      std::memcpy(pixels, current ? current->data : buffer->buf_act, image->data_size);
      transition_snapshot_ = image;
    } else { lv_mem_free(image); lv_mem_free(pixels); }
  } else transition_snapshot_ = lv_snapshot_take(screen_, LV_IMG_CF_TRUE_COLOR);
  if (notice_) { lv_obj_del(notice_); notice_ = nullptr; notice_until_ = 0; }
  if (!transition_snapshot_) return;
  transition_image_ = lv_img_create(lv_layer_top());
  lv_img_set_src(transition_image_, transition_snapshot_);
  lv_obj_add_flag(transition_image_, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_pos(transition_image_, 0, 0);
  lv_obj_set_style_opa(transition_image_, LV_OPA_COVER, 0);
  transition_started_ = false;
}
void Ui::set_seed(const std::string& seed) {
  if (seed == seed_ && eyes_art_.image()->data) return;
  image_ = nullptr; texture_ = nullptr;
  std::swap(art_.identity, cached_art_.identity); eyes_art_.swap(cached_eyes_art_); mouth_art_.swap(cached_mouth_art_);
  std::swap(seed_, cached_seed_);
  if (seed != seed_ || !eyes_art_.image()->data) {
    seed_ = seed; art_.identity = avatar_identity(seed);
    eyes_art_.load(assets::eyes[art_.identity.eyes].image);
    mouth_art_.load(assets::mouth[art_.identity.mouth].image);
  }
}
void Ui::set_human_seed(const std::string& seed) { human_image_ = nullptr; human_art_.set_seed(seed, true); }
void Ui::set_peer_seed(const std::string& seed) { peer_image_ = nullptr; peer_art_.set_seed(seed, true); }
void Ui::set_human_image(const lv_img_dsc_t* image) { human_image_ = image; }
void Ui::set_peer_image(const lv_img_dsc_t* image) { peer_image_ = image; }
void Ui::notify(const std::string& text) {
  if (notice_) lv_obj_del(notice_);
  notice_ = lv_obj_create(lv_scr_act());
  lv_obj_set_size(notice_, 300, 80);
  lv_obj_align(notice_, LV_ALIGN_BOTTOM_MID, 0, -60);
  lv_obj_set_style_bg_color(notice_, lv_color_black(), 0);
  lv_obj_set_style_bg_opa(notice_, 230, 0);
  lv_obj_set_style_border_width(notice_, 1, 0);
  lv_obj_set_style_border_color(notice_, lv_color_hex(pastels[3]), 0);
  lv_obj_set_style_radius(notice_, 16, 0);
  lv_obj_clear_flag(notice_, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
  auto* message = label(notice_, text, 264);
  lv_obj_set_style_text_align(message, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_center(message);
  notice_until_ = lv_tick_get() + 3000;
}

void Ui::update_history_arrow() {
  if (!latest_ || !history_) return;
  if (reading_latest()) lv_obj_add_flag(latest_, LV_OBJ_FLAG_HIDDEN);
  else lv_obj_clear_flag(latest_, LV_OBJ_FLAG_HIDDEN);
}
void Ui::history_scrolled(lv_event_t* event) {
  auto* ui = static_cast<Ui*>(lv_event_get_user_data(event));
  const auto code = lv_event_get_code(event);
  if (code == LV_EVENT_SCROLL_BEGIN) {
    ui->user_scrolling_ = lv_indev_get_act() != nullptr;
    ui->scroll_direction_ = 0;
  } else if (code == LV_EVENT_SCROLL) {
    const auto* input = lv_indev_get_act();
    lv_point_t movement{};
    if (input) lv_indev_get_vect(input, &movement);
    if (ui->user_scrolling_ && std::abs(movement.y) > 1) ui->scroll_direction_ = movement.y > 0 ? -1 : 1;
    ui->update_history_arrow();
  } else if (code == LV_EVENT_SCROLL_END && ui->user_scrolling_) {
    ui->user_scrolling_ = false;
    if (ui->scroll_direction_ < 0 && lv_obj_get_scroll_y(ui->history_) < 32 && ui->history_has_older_) ui->history_edge_ = -1;
    else if (ui->scroll_direction_ > 0 && lv_obj_get_scroll_bottom(ui->history_) < 32 && ui->history_has_newer_) ui->history_edge_ = 1;
  }
}
void Ui::scroll_to_latest() {
  if (!history_ || history_has_newer_) return;
  user_scrolling_ = false;
  lv_obj_scroll_to_y(history_, lv_obj_get_scroll_y(history_) + lv_obj_get_scroll_bottom(history_), LV_ANIM_OFF);
  update_history_arrow();
}
bool Ui::reading_latest() const { return history_ && !history_has_newer_ && lv_obj_get_scroll_bottom(history_) < 8; }
std::string Ui::reading_anchor() const {
  if (!history_) return "";
  const int scroll = lv_obj_get_scroll_y(history_);
  for (size_t i = 0; i < message_ids_.size(); ++i) {
    const auto* child = lv_obj_get_child(history_, i);
    if (lv_obj_get_y(child) + lv_obj_get_height(child) > scroll) return message_ids_[i];
  }
  return "";
}
void Ui::refresh_conversation(const Interaction& state, const UiData& data, bool preserve) {
  const auto anchor = preserve ? reading_anchor() : "";
  int offset = 0;
  if (!anchor.empty()) for (size_t i = 0; i < message_ids_.size(); ++i) if (message_ids_[i] == anchor) offset = lv_obj_get_y(lv_obj_get_child(history_, i)) - lv_obj_get_scroll_y(history_);
  show(state, data);
  if (!anchor.empty() && history_) for (size_t i = 0; i < message_ids_.size(); ++i) if (message_ids_[i] == anchor) {
    lv_obj_update_layout(history_);
    lv_obj_scroll_to_y(history_, lv_obj_get_y(lv_obj_get_child(history_, i)) - offset, LV_ANIM_OFF);
    break;
  }
  update_history_arrow();
}
}
