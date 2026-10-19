#include "ui.h"
#include "usb_mirror.h"
#include "native_frame.h"
#include "generated/face_assets.h"
#include <fstream>
#include <iostream>
#include <filesystem>
#include <cassert>
#include <cstring>

#if ALOOK_TOUCH_USB_MIRROR
namespace alook_touch { void usb_mirror_render(uint32_t, uint32_t) {} }
#endif
using namespace alook_touch;
static lv_color_t pixels[466 * 466];
static lv_color_t buffer[466 * 466];
static lv_indev_data_t pointer;
static Ui* rendering_ui;
static uint32_t* rendering_time;
static bool saw_full_flush_with_partial_clip = false;
static std::string json_text(const std::string& value) {
  std::string result = "\"";
  const char* hex = "0123456789abcdef";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
    else result += c;
  }
  return result + "\"";
}
static const char* action_name(Action action) {
#define ALOOK_ACTION_NAME(name) case Action::name: return #name;
  switch (action) {
    ALOOK_ACTION_NAME(SetupNetwork) ALOOK_ACTION_NAME(ManualNetwork) ALOOK_ACTION_NAME(Authorize) ALOOK_ACTION_NAME(Profile)
    ALOOK_ACTION_NAME(Requests) ALOOK_ACTION_NAME(Bots) ALOOK_ACTION_NAME(Settings)
    ALOOK_ACTION_NAME(Logout) ALOOK_ACTION_NAME(ConfirmLogout) ALOOK_ACTION_NAME(Chat)
    ALOOK_ACTION_NAME(AdjacentBot) ALOOK_ACTION_NAME(Send) ALOOK_ACTION_NAME(Retry)
    ALOOK_ACTION_NAME(Rerecord) ALOOK_ACTION_NAME(Cancel) ALOOK_ACTION_NAME(AddFriend)
    ALOOK_ACTION_NAME(AcceptFriend) ALOOK_ACTION_NAME(AcceptRequest) ALOOK_ACTION_NAME(Back)
    ALOOK_ACTION_NAME(Brightness) ALOOK_ACTION_NAME(Older) ALOOK_ACTION_NAME(Newer) ALOOK_ACTION_NAME(Latest)
    ALOOK_ACTION_NAME(Dms) ALOOK_ACTION_NAME(OpenDm)
    ALOOK_ACTION_NAME(Update) ALOOK_ACTION_NAME(CheckUpdate) ALOOK_ACTION_NAME(InstallUpdate)
  }
#undef ALOOK_ACTION_NAME
  return "Unknown";
}
static void input_at(int x, int y, bool pressed) {
  pointer.point = {static_cast<lv_coord_t>(x), static_cast<lv_coord_t>(y)};
  pointer.state = pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
  lv_tick_inc(40); lv_timer_handler();

}
static void swipe(int x, int y, int dx, int dy) {
  input_at(x, y, false);
  input_at(x, y, true);
  for (int step = 1; step <= 4; ++step) input_at(x + dx * step / 4, y + dy * step / 4, true);
  input_at(x + dx, y + dy, false);
}
static lv_point_t control_center(const char* text, size_t occurrence = 0) {
  std::function<lv_obj_t*(lv_obj_t*)> find = [&](lv_obj_t* parent) -> lv_obj_t* {
    for (uint32_t i = 0; i < lv_obj_get_child_cnt(parent); ++i) {
      auto* object = lv_obj_get_child(parent, i);
      if (lv_obj_check_type(object, &lv_btn_class)) {
        auto* label = lv_obj_get_child(object, 0);
        if (std::string(lv_label_get_text(label)) == text) {
          if (occurrence == 0) return object;
          --occurrence;
        }
      }
      if (auto* match = find(object)) return match;
    }
    return nullptr;
  };
  auto* object = find(lv_scr_act());
  assert(object);
  lv_area_t area; lv_obj_get_coords(object, &area);
  return {static_cast<lv_coord_t>((area.x1 + area.x2) / 2), static_cast<lv_coord_t>((area.y1 + area.y2) / 2)};
}
static void tap_control(const char* text, size_t occurrence = 0) {
  const auto point = control_center(text, occurrence);
  input_at(point.x, point.y, true); input_at(point.x, point.y, false);
}
static size_t control_count(const char* text) {
  std::function<size_t(lv_obj_t*)> count = [&](lv_obj_t* parent) {
    size_t result = 0;
    for (uint32_t i = 0; i < lv_obj_get_child_cnt(parent); ++i) {
      auto* child = lv_obj_get_child(parent, i);
      if (lv_obj_check_type(child, &lv_btn_class) && std::string(lv_label_get_text(lv_obj_get_child(child, 0))) == text) ++result;
      result += count(child);
    }
    return result;
  };
  return count(lv_scr_act());
}
static bool has_label(lv_obj_t* parent, const char* text) {
  if (lv_obj_check_type(parent, &lv_label_class) && std::string(lv_label_get_text(parent)) == text) return true;
  for (uint32_t i = 0; i < lv_obj_get_child_cnt(parent); ++i) if (has_label(lv_obj_get_child(parent, i), text)) return true;
  return false;
}
static void flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* colors) {
  const auto* clip = driver->draw_ctx->clip_area;
  if (area->y1 == 0 && area->y2 == 465 && clip && (clip->y1 > 0 || clip->y2 < 465)) saw_full_flush_with_partial_clip = true;
  preview_board_flush(driver, area, colors, pixels);
}
static void settle_transition() {
  for (int i = 0; i < 12; ++i) { lv_tick_inc(30); rendering_ui->tick(*rendering_time += 30); lv_timer_handler(); }
  lv_refr_now(nullptr);
}
static void capture(const std::string& path) {
  settle_transition();
  lv_refr_now(nullptr);
  if (path.find("/network") != std::string::npos) {
    for (size_t i = 0; i < 466 * 466; ++i) assert(pixels[i].full == buffer[i].full);
    for (const auto& control : rendering_ui->controls()) {
      size_t ink = 0;
      for (int y = control.y; y < control.y + control.height; ++y) for (int x = control.x; x < control.x + control.width; ++x) {
        if (x < 0 || x >= 466 || y < 0 || y >= 466) continue;
        const auto pixel = pixels[y * 466 + x];
        ink += pixel.ch.red > 12 || pixel.ch.green > 25 || pixel.ch.blue > 12;
      }
      assert(ink > 50);
    }
  }
  std::ofstream output(path, std::ios::binary);
  output << "P6\n466 466\n255\n";
  for (const auto color : pixels) {
    uint8_t rgb[] = {static_cast<uint8_t>(color.ch.red * 255 / 31), static_cast<uint8_t>(color.ch.green * 255 / 63), static_cast<uint8_t>(color.ch.blue * 255 / 31)};
    output.write(reinterpret_cast<char*>(rgb), sizeof(rgb));
  }
  auto controls_path = std::filesystem::path(path); controls_path.replace_extension(".controls.json");
  std::ofstream controls(controls_path);
  controls << "[";
  bool first = true;
  for (const auto& control : rendering_ui->controls()) {
    if (!first) controls << ",";
    first = false;
    controls << "{\"label\":" << json_text(control.label) << ",\"action\":" << json_text(action_name(control.action))
      << ",\"argument\":" << control.argument << ",\"x\":" << control.x << ",\"y\":" << control.y
      << ",\"width\":" << control.width << ",\"height\":" << control.height
      << ",\"disabled\":" << (control.disabled ? "true" : "false") << ",\"event\":" << json_text(control.long_press ? "hold" : "click") << "}";
  }
  controls << "]";
}
static bool idle_changes(Ui& ui, uint32_t& time) {
  lv_refr_now(nullptr);
  std::array<lv_color_t, 466 * 466> before;
  std::copy(std::begin(pixels), std::end(pixels), before.begin());
  bool changed = false;
  for (int step = 0; step < 100; ++step) {
    ui.tick(time += 40);
    lv_tick_inc(40); lv_timer_handler(); lv_refr_now(nullptr);
    for (size_t i = 0; i < before.size(); ++i) changed = changed || before[i].full != pixels[i].full;
  }
  return changed;
}
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  const std::string output = argv[1];
  std::filesystem::create_directories(output);
  lv_init();
  lv_disp_draw_buf_t draw{};
  lv_disp_draw_buf_init(&draw, buffer, nullptr, 466 * 466);
  lv_disp_drv_t driver;
  lv_disp_drv_init(&driver);
  driver.direct_mode = 1;
  driver.hor_res = driver.ver_res = 466;
  driver.flush_cb = flush;
  driver.draw_buf = &draw;
  lv_disp_drv_register(&driver);
  lv_indev_drv_t input;
  lv_indev_drv_init(&input);
  input.type = LV_INDEV_TYPE_POINTER;
  input.read_cb = [](lv_indev_drv_t*, lv_indev_data_t* data) { *data = pointer; };
  lv_indev_drv_register(&input);
  std::vector<std::pair<Action, int>> actions;
  Ui ui;
  rendering_ui = &ui;
  ui.begin([&](Action action, int argument) { actions.emplace_back(action, argument); });
  {
    FeatureArt projected;
    const auto feature = assets::eyes[0];
    assert(projected.load(feature.image));
    auto spans = [&](float look) {
      bool changed = false;
      const auto* image = projected.project(look, feature.x, feature.y - 44, changed);
      assert(image->header.w < 466 && changed);
      std::vector<std::pair<int, int>> runs;
      bool inside = false;
      for (int x = 0; x < image->header.w; ++x) {
        int mass = 0;
        for (int y = 0; y < image->header.h; ++y) mass += image->data[(y * image->header.w + x) * 3 + 2];
        if (mass > 255 && !inside) { runs.emplace_back(x + projected.projected_x(), x + projected.projected_x()); inside = true; }
        else if (mass > 255) runs.back().second = x + projected.projected_x();
        else inside = false;
      }
      assert(runs.size() == 2);
      return runs;
    };
    const auto center = spans(0), right = spans(1), left = spans(-1);
    const auto width = [](const auto& run) { return run.second - run.first + 1; };
    const auto distance = [](const auto& runs) { return runs[1].first + runs[1].second - runs[0].first - runs[0].second; };
    assert(width(right[0]) > width(right[1]));
    assert(width(left[0]) < width(left[1]));
    assert(distance(right) < distance(center) && distance(left) < distance(center));
    assert(right[0].first - center[0].first > 30 && center[1].second - left[1].second > 30);
    bool changed = true;
    projected.project(-1, feature.x, feature.y - 44, changed); assert(!changed);
  }
  ui.set_seed("Samara");
  ui.set_human_seed("Alex");
  ui.set_peer_seed("Riley");
  Interaction state;
  state.sign_in("preview-human");
  state.select_recipient("preview-bot");
  UiData data;
  data.human_name = "Alex";
  data.human_handle = "Alex#0042";
  data.bot_name = "Samara";
  data.status = "Online"; data.battery = 78; data.bot_online = true;
  uint32_t time = 0;
  rendering_time = &time;
  const auto scene = [&](Page page, const std::string& name) {
    state.page = page;
    ui.show(state, data);
    ui.tick(time += 1000);
    capture(output + "/" + name + ".ppm");
  };
  scene(Page::Startup, "startup");
  scene(Page::Character, "character");
  swipe(330, 233, -160, 0);
  swipe(136, 233, 160, 0);
  swipe(233, 330, 0, -160);
  swipe(233, 136, 0, 160);
  assert(actions.size() == 3);
  assert(actions[0] == std::make_pair(Action::AdjacentBot, 1));
  assert(actions[1] == std::make_pair(Action::AdjacentBot, -1));
  assert(actions[2].first == Action::Chat);
  actions.clear();
  ui.set_seed("Pip"); data.bot_name = "Pip";
  scene(Page::Character, "character-pip");
  data.bot_online = false;
  scene(Page::Character, "character-pip-offline");
  ui.set_seed("Samara"); data.bot_name = "Samara";
  data.bot_online = false;
  scene(Page::Character, "character-offline");
  ui.notify("Connect Wi-Fi to record.");
  capture(output + "/recording-offline.ppm");
  lv_tick_inc(3100); ui.tick(time += 3100);
  assert(lv_obj_get_child_cnt(lv_scr_act()) == 2);
  capture(output + "/recording-notice-cleared.ppm");
  data.bot_online = true;
  ui.show(state, data);
  ui.notify("Open Chat before recording.");
  capture(output + "/recording-chat-not-ready.ppm");
  data.bot_online = true;
  scene(Page::Home, "home");
  const auto bots_center = control_center("Bots");
  swipe(bots_center.x + 60, bots_center.y, -120, 0);
  assert(actions.empty());
  for (const auto* name : {"Bots", "Profile", "More"}) tap_control(name);
  assert(actions.size() == 3);
  assert(actions[0].first == Action::Bots && actions[1].first == Action::Profile && actions[2].first == Action::Settings);
  actions.clear();
  scene(Page::Settings, "settings");
  const auto network_center = control_center("Wi-Fi setup");
  swipe(network_center.x + 60, network_center.y, -120, 0);
  assert(actions.empty());
  for (const auto* name : {"Wi-Fi setup", "Brightness", "Log out"}) tap_control(name);
  assert(actions.size() == 3);
  assert(actions[0].first == Action::SetupNetwork && actions[1].first == Action::Brightness && actions[2].first == Action::Logout);
  actions.clear();
  data.has_older = true;
  data.messages = {{"11", "Alex", "How was your day?", true, 11}, {"12", "Samara", "Good. I found a quiet route along the river for our walk.", false, 12}, {"13", "Alex", "I could use a walk by the river.", true, 13}, {"14", "Samara", "How about 6:30? Bring a light jacket. It gets windy by the river.", false, 14}, {"15", "Alex", "Sounds good. Let me finish this first.", true, 15}, {"16", "Samara", "I will check the weather before we leave.", false, 16}};
  scene(Page::Conversation, "conversation");
  assert(ui.reading_latest());
  auto* history = lv_obj_get_child(lv_scr_act(), 1);
  lv_obj_scroll_to_y(history, 0, LV_ANIM_OFF);
  capture(output + "/conversation-history.ppm");
  assert(!ui.reading_latest());
  assert(!lv_obj_has_flag(lv_obj_get_child(lv_scr_act(), 2), LV_OBJ_FLAG_HIDDEN));
  const auto anchor = ui.reading_anchor();
  const auto offset = lv_obj_get_y(lv_obj_get_child(history, 0)) - lv_obj_get_scroll_y(history);
  data.messages.insert(data.messages.begin(), {{"9", "Alex", "Let us make time for a walk tonight.", true, 9}, {"10", "Samara", "I will keep the evening free.", false, 10}});
  ui.refresh_conversation(state, data, true);
  history = lv_obj_get_child(lv_scr_act(), 1);
  assert(ui.reading_anchor() == anchor);
  assert(lv_obj_get_y(lv_obj_get_child(history, 2)) - lv_obj_get_scroll_y(history) == offset);
  ui.scroll_to_latest();
  assert(ui.reading_latest());
  assert(lv_obj_has_flag(lv_obj_get_child(lv_scr_act(), 2), LV_OBJ_FLAG_HIDDEN));
  data.has_newer = true;
  scene(Page::Conversation, "conversation-old-tail");
  assert(!ui.reading_latest());
  assert(!lv_obj_has_flag(lv_obj_get_child(lv_scr_act(), 2), LV_OBJ_FLAG_HIDDEN));
  data.has_newer = false;
  for (const auto& item : {std::make_pair(Page::RecordReady, "record-ready"), std::make_pair(Page::Recording, "recording"), std::make_pair(Page::Transcribing, "transcribing")}) {
    scene(item.first, item.second);
    actions.clear(); tap_control(LV_SYMBOL_CLOSE);
    assert(actions.size() == 1 && actions[0].first == Action::Cancel);
  }
  state.voice = VoicePhase::Review;
  state.draft = "Meet me downstairs at 6:30. Let us walk by the river, then find a quiet place for dinner. If it rains, we can go to the bookshop instead. Please check the weather and remind me to bring an umbrella.\n\nLast line: wait for my confirmation before sending.";
  scene(Page::Review, "review");
  actions.clear(); tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE); tap_control("Send message");
  assert(actions.size() == 3);
  assert(actions[0].first == Action::Rerecord && actions[1].first == Action::Cancel && actions[2].first == Action::Send);
  actions.clear();
  auto* panel = lv_obj_get_child(lv_scr_act(), 1);
  lv_obj_update_layout(panel);
  lv_area_t review_area;
  lv_obj_get_coords(panel, &review_area);
  assert(review_area.y2 < control_center("Send message").y - 24);
  assert(control_center("Send message").y + 24 < control_center(LV_SYMBOL_REFRESH).y - 22);
  assert(lv_obj_get_scroll_bottom(panel) > 0);
  lv_obj_scroll_to_y(panel, lv_obj_get_scroll_bottom(panel), LV_ANIM_OFF);
  capture(output + "/review-end.ppm");
  state.voice = VoicePhase::Sending;
  state.nonce = "preview-only-nonce";
  scene(Page::Review, "sending");
  tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE); tap_control("Sending...");
  assert(actions.empty());
  state.voice = VoicePhase::Failed;
  data.error = "Could not send. Check your connection.";
  scene(Page::Review, "send-failed");
  actions.clear(); tap_control("Retry message"); tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE);
  assert(actions.size() == 3);
  assert(actions[0].first == Action::Retry && actions[1].first == Action::Rerecord && actions[2].first == Action::Cancel);
  actions.clear();
  const auto sample_draft = state.draft;
  state.draft.clear(); state.nonce.clear();
  data.error = "Could not transcribe. Record again.";
  scene(Page::Review, "transcription-failed");
  tap_control("Send message");
  assert(actions.empty());
  tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE);
  assert(actions.size() == 2 && actions[0].first == Action::Rerecord && actions[1].first == Action::Cancel);
  actions.clear();
  state.draft = sample_draft;
  data.error.clear();
  state.nonce.clear();
  state.voice = VoicePhase::Empty;
  data.requests_loaded = true;
  data.requests = {{"request-new", "u-riley", "Riley", "incoming"}, {"request-sent", "u-jordan", "Jordan", "outgoing"}, {"request-old", "u-casey", "Casey", "incoming"}, {"request-owner", "u-morgan", "Morgan", "outgoing", true}, {"request-taylor", "u-taylor", "Taylor", "incoming"}};
  const auto sample_requests = data.requests;
  scene(Page::Profile, "profile");
  actions.clear(); tap_control("Accept");
  assert(actions.size() == 1 && actions[0] == std::make_pair(Action::AcceptRequest, 0));
  actions.clear();
  auto* requests = lv_obj_get_child(lv_scr_act(), 4);
  assert(lv_obj_get_child_cnt(requests) == 3);
  assert(std::string(lv_label_get_text(lv_obj_get_child(lv_obj_get_child(requests, 1), 0))) == "Casey");
  assert(std::string(lv_label_get_text(lv_obj_get_child(lv_obj_get_child(requests, 2), 0))) == "Taylor");
  lv_obj_scroll_to_y(requests, lv_obj_get_scroll_bottom(requests), LV_ANIM_OFF);
  capture(output + "/profile-history.ppm");
  tap_control("Accept", 1);
  assert(actions.size() == 1 && actions[0] == std::make_pair(Action::AcceptRequest, 2));
  actions.clear();
  data.request_busy = "request-new";
  scene(Page::Profile, "profile-accepting");
  tap_control("..."); assert(actions.empty());
  tap_control("Accept"); assert(actions.empty());
  data.request_busy.clear();
  data.requests_error = "Could not accept. Try again.";
  scene(Page::Profile, "profile-accept-failed");
  data.requests_error.clear();
  data.requests.erase(data.requests.begin());
  scene(Page::Profile, "profile-after-accept");
  data.requests = {{"only-sent", "u-jordan", "Jordan", "outgoing"}};
  scene(Page::Profile, "profile-only-outgoing");
  auto* outgoing_only = lv_obj_get_child(lv_scr_act(), 4);
  assert(lv_obj_get_child_cnt(outgoing_only) == 1);
  assert(std::string(lv_label_get_text(lv_obj_get_child(outgoing_only, 0))) == "No friend requests");
  data.requests.clear();
  scene(Page::Profile, "profile-empty");
  data.requests_loaded = false;
  scene(Page::Profile, "profile-loading");
  data.requests_error = "Could not load requests. Try again.";
  ui.show(state, data);
  auto* failed_requests = lv_obj_get_child(lv_scr_act(), 4);
  assert(lv_obj_get_child_cnt(failed_requests) == 1);
  assert(std::string(lv_label_get_text(lv_obj_get_child(failed_requests, 0))) == data.requests_error);
  data.requests_loaded = true;
  ui.show(state, data);
  failed_requests = lv_obj_get_child(lv_scr_act(), 4);
  assert(lv_obj_get_child_cnt(failed_requests) == 1);
  data.requests_error.clear();
  data.requests_loaded = true;
  for (int i = 0; i < 80; ++i) data.requests.push_back({"large-" + std::to_string(i), "user-" + std::to_string(i), "Person " + std::to_string(i + 1), "incoming"});
  scene(Page::Profile, "profile-large-list");
  requests = lv_obj_get_child(lv_scr_act(), 4);
  lv_obj_scroll_to_y(requests, lv_obj_get_scroll_bottom(requests), LV_ANIM_OFF);
  actions.clear(); tap_control("Accept", 79);
  assert(actions.size() == 1 && actions[0] == std::make_pair(Action::AcceptRequest, 79));
  actions.clear();
  data.requests = sample_requests;
  data.peer_name = "Riley";
  data.peer_handle = "Riley#0027";
  scene(Page::Profile, "nearby");
  actions.clear(); tap_control(LV_SYMBOL_CLOSE);
  assert(actions.size() == 1 && actions[0].first == Action::Requests);
  actions.clear();
  const auto nearby_owner = state.owner();
  assert(state.show_requests());
  assert(!state.accepts_profile(nearby_owner));
  scene(Page::Profile, "profile-returned");
  assert(std::string(lv_label_get_text(lv_obj_get_child(lv_scr_act(), 0))) == "My profile");
  scene(Page::Profile, "profile-returned-peer-nearby");
  assert(state.profile_requests_only);
  assert(std::string(lv_label_get_text(lv_obj_get_child(lv_scr_act(), 0))) == "My profile");
  state.enter(Page::Character); state.enter(Page::Profile);
  assert(!state.profile_requests_only);
  scene(Page::Profile, "nearby-reentered");
  assert(std::string(lv_label_get_text(lv_obj_get_child(lv_scr_act(), 0))).empty());
  const auto check_friend_error = [&](const char* control, Action expected) {
    assert(lv_obj_get_child_cnt(lv_scr_act()) == 6);
    lv_area_t notice, identity;
    lv_obj_get_coords(lv_obj_get_child(lv_scr_act(), 5), &notice);
    lv_obj_get_coords(lv_obj_get_child(lv_scr_act(), 2), &identity);
    assert(notice.y2 < control_center(LV_SYMBOL_CLOSE).y - 22);
    assert(control_center(control).y + 24 < control_center(LV_SYMBOL_CLOSE).y - 22);
    assert(notice.y2 < identity.y1);
    assert(notice.y2 < control_center(control).y - 24);
    actions.clear(); tap_control(control);
    assert(actions.size() == 1 && actions[0].first == expected);
    actions.clear();
  };
  data.error = "Could not send the request.\nTry again.";
  scene(Page::Profile, "friend-send-failed");
  check_friend_error("Add friend", Action::AddFriend);
  data.error.clear();
  data.peer_state = "incoming";
  scene(Page::Profile, "friend-request");
  data.error = "Could not accept the request.\nTry again.";
  scene(Page::Profile, "friend-accept-failed");
  check_friend_error("Accept request", Action::AcceptFriend);
  data.error.clear();
  data.peer_state = "outgoing";
  scene(Page::Profile, "friend-request-sent");
  data.peer_state = "friends";
  scene(Page::Profile, "already-friends");
  data.status = "Wi-Fi connected\nBattery 78% / Brightness 60%";
  scene(Page::Settings, "settings");
  scene(Page::LogoutConfirmation, "logout");
  actions.clear(); tap_control(LV_SYMBOL_CLOSE); tap_control("Log out");
  assert(actions.size() == 2);
  assert(actions[0].first == Action::Back && actions[1].first == Action::ConfirmLogout);
  actions.clear();
  data.bots.clear();
  data.bots_loaded = true;
  scene(Page::Bots, "no-bots");
  actions.clear(); tap_control("Reload BOTs");
  assert(actions.size() == 1 && actions[0].first == Action::Bots);
  actions.clear();
  data.bots_loaded = false;
  scene(Page::Bots, "loading-bots");
  assert(lv_obj_get_child_cnt(lv_scr_act()) == 1);
  data.bots_loaded = true;
  data.ble_setup = true;
  data.qr.clear(); data.short_code.clear(); data.status = "Preparing secure Bluetooth setup…";
  scene(Page::Network, "network-preparing");
  actions.clear(); tap_control(LV_SYMBOL_REFRESH); tap_control("Manual Wi-Fi"); tap_control(LV_SYMBOL_CLOSE);
  assert(actions.size() == 3 && actions[0].first == Action::SetupNetwork && actions[1].first == Action::ManualNetwork && actions[2].first == Action::Back);
  data.qr = R"({"ver":"v1","name":"ALOOK_TOUCH_A1B2C3","pop":"0123456789abcdef0123456789abcdef","transport":"ble","security":1,"service_uuid":"b4df5a1c-3f6b-f4bf-ea4a-820304901a02"})";
  data.status = "Alook > Settings > Devices\nAdd Touch, then scan";
  scene(Page::Network, "network");
  actions.clear(); tap_control("Manual Wi-Fi");
  assert(actions.size() == 1 && actions[0].first == Action::ManualNetwork);
  data.short_code = "DEMO-1234"; data.status = "Continue on your phone\nCheck this code, then approve";
  scene(Page::Authorization, "network-authorization");
  actions.clear(); tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE);
  assert(actions.size() == 2 && actions[0].first == Action::Authorize && actions[1].first == Action::Back);
  data.ble_setup = false;
  data.qr = "WIFI:T:WPA;S:Alook-touch-DEMO;P:demo-only;;";
  data.short_code = "192.168.4.1";
  data.status = "Scan to join touch Wi-Fi\nOpen the address below";
  scene(Page::Network, "network-manual");
  actions.clear(); tap_control(LV_SYMBOL_REFRESH);
  assert(actions.size() == 1 && actions[0].first == Action::SetupNetwork);
  actions.clear();
  data.qr.clear();
  data.status = "Authorize this touch on your phone";
  scene(Page::Authorization, "authorization-empty");
  tap_control("Get a new code");
  assert(actions.size() == 1 && actions[0].first == Action::Authorize);
  actions.clear();
  data.qr = "https://alook.ai/device?user_code=DEMO-1234";
  data.short_code = "DEMO-1234";
  data.status = "Scan with your phone to sign in";
  scene(Page::Authorization, "authorization");
  tap_control(LV_SYMBOL_REFRESH);
  assert(actions.size() == 1 && actions[0].first == Action::Authorize);
  actions.clear();
  std::ifstream photo(output + "/photo.bin", std::ios::binary);
  if (photo) {
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(photo)), std::istreambuf_iterator<char>());
    lv_img_dsc_t image{};
    image.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA;
    image.header.w = image.header.h = 288;
    image.data_size = bytes.size();
    image.data = bytes.data();
    ui.set_character(&image);
    data.bot_custom = true;
    data.status = "Online";
    scene(Page::Character, "character-photo");
    ui.set_seed("retained-photo-seed"); ui.set_character(&image); ui.show(state, data);
    ui.set_seed("retained-photo-seed"); ui.show(state, data);
    auto* retained_photo = lv_obj_get_child(lv_obj_get_child(lv_scr_act(), 1), 0);
    assert(lv_img_get_src(retained_photo) == &image);
    assert(!idle_changes(ui, time));
    assert(!idle_changes(ui, time));
    data.bot_online = false;
    scene(Page::Character, "character-photo-offline");
    ui.set_peer_image(&image);
    data.peer_custom = true;
    data.peer_state.clear();
    scene(Page::Profile, "nearby-photo");
  }
  ui.set_seed("Pip"); data.bot_name = "Pip"; data.bot_custom = false;
  data.status = "Online"; data.bot_online = true;
  for (auto& message : data.messages) if (!message.own) message.author = "Pip";
  data.has_newer = false;
  scene(Page::Conversation, "conversation-pip");
  auto* pip_history = lv_obj_get_child(lv_scr_act(), 1);
  lv_obj_scroll_to_y(pip_history, 0, LV_ANIM_OFF);
  capture(output + "/conversation-history-pip.ppm");
  data.has_newer = true;
  scene(Page::Conversation, "conversation-old-tail-pip");
  data.has_newer = false;
  scene(Page::RecordReady, "record-ready-pip");
  scene(Page::Recording, "recording-pip");
  scene(Page::Transcribing, "transcribing-pip");
  state.voice = VoicePhase::Review;
  scene(Page::Review, "review-pip");
  auto* pip_review = lv_obj_get_child(lv_scr_act(), 1);
  lv_obj_update_layout(pip_review);
  lv_obj_scroll_to_y(pip_review, lv_obj_get_scroll_bottom(pip_review), LV_ANIM_OFF);
  capture(output + "/review-end-pip.ppm");
  state.voice = VoicePhase::Sending;
  state.nonce = "preview-only-nonce";
  scene(Page::Review, "sending-pip");
  state.voice = VoicePhase::Failed;
  data.error = "Could not send. Check your connection.";
  scene(Page::Review, "send-failed-pip");
  state.draft.clear(); state.nonce.clear();
  data.error = "Could not transcribe. Record again.";
  scene(Page::Review, "transcription-failed-pip");
  state.cancel_draft(); state.select_recipient("preview-riley");
  data.dm_enabled = true; data.dms_loaded = true; data.dm_human = true;
  data.dm_handle = "Riley#0027"; data.dm_id = "dm-riley";
  data.dms = {{"dm-riley", "preview-riley", "Riley#0027", "See you at 6:30", true, true, true}, {"dm-samara", "preview-bot", "Samara#8738", "I will check the weather", false, true, false}, {"dm-pip", "preview-pip", "Pip#0023", "The route is ready", false, false, true}, {"dm-taylor", "preview-taylor", "Taylor#0051", "Thanks for the map", true, false, false}};
  data.error.clear(); data.dm_error.clear(); data.bot_online = true;
  ui.set_seed("Riley");
  scene(Page::Home, "dm-home");
  actions.clear(); tap_control("DMs"); assert(actions.size() == 1 && actions[0].first == Action::Dms);
  scene(Page::DmList, "dm-list");
  actions.clear(); tap_control("Riley#0027"); tap_control("Samara#8738");
  assert(actions.size() == 2 && actions[0] == std::make_pair(Action::OpenDm, 0) && actions[1] == std::make_pair(Action::OpenDm, 1));
  assert(control_count(LV_SYMBOL_PLUS) == 0);
  actions.clear(); tap_control(LV_SYMBOL_REFRESH); assert(actions.size() == 1 && actions[0].first == Action::Dms);
  const auto sample_dms = data.dms;
  data.dms.clear(); data.dms_loaded = false; scene(Page::DmList, "dm-loading");
  data.dms_loaded = true; scene(Page::DmList, "dm-empty");
  assert(has_label(lv_scr_act(), "No direct messages yet"));
  data.dm_error = "Could not load DMs. Try again."; scene(Page::DmList, "dm-list-error");
  assert(has_label(lv_scr_act(), "Could not load DMs. Try again."));
  assert(!has_label(lv_scr_act(), "No direct messages yet") && !has_label(lv_scr_act(), "Loading..."));
  data.dms = sample_dms; scene(Page::DmList, "dm-list-error-cached");
  assert(has_label(lv_scr_act(), "Could not load DMs. Try again.") && has_label(lv_scr_act(), "Riley#0027"));
  assert(!has_label(lv_scr_act(), "No direct messages yet"));
  data.dm_error.clear(); data.dms = sample_dms;
  const char* peer_keys[] = {"human", "bot", "pip", "taylor"};
  for (size_t i = 0; i < sample_dms.size(); ++i) {
    const auto& peer = sample_dms[i];
    const std::string key = peer_keys[i];
    state.cancel_draft(); const auto prior_owner = state.owner();
    assert(state.select_recipient(peer.user_id));
    if (i > 0) assert(!state.accepts_recipient(prior_owner));
    data.dm_id = peer.id; data.dm_handle = peer.handle; data.dm_human = peer.human; data.bot_online = peer.online;
    const auto name = peer.handle.substr(0, peer.handle.find('#'));
    ui.set_seed(name);
    data.messages.clear();
    for (int n = 1; n <= 12; ++n) data.messages.push_back({key + "-" + std::to_string(n), n % 2 ? name : "Alex", n % 2 ? "See you at 6:30. Bring a light jacket." : "Great. I will bring the map.", n % 2 == 0, static_cast<uint32_t>(n)});
    data.has_older = true; data.has_newer = false;
    scene(Page::DmList, "dm-" + key + "-list");
    auto* list_panel = lv_obj_get_child(lv_scr_act(), 1);
    lv_obj_scroll_to_y(list_panel, lv_obj_get_scroll_bottom(list_panel), LV_ANIM_OFF);
    capture(output + "/dm-" + key + "-list-end.ppm");
    scene(Page::Character, "dm-" + key);
    scene(Page::Conversation, "dm-" + key + "-chat");
    assert(control_count(LV_SYMBOL_SETTINGS) == 0 && control_count(LV_SYMBOL_EDIT) == 0);
    auto* chat_panel = lv_obj_get_child(lv_scr_act(), 1);
    lv_obj_scroll_to_y(chat_panel, 0, LV_ANIM_OFF);
    capture(output + "/dm-" + key + "-history.ppm");
    data.has_newer = true; scene(Page::Conversation, "dm-" + key + "-old-tail");
    data.has_newer = false;
    data.dm_can_send = false; scene(Page::Conversation, "dm-" + key + "-cannot-send");
    data.dm_can_read = false; data.has_older = false; scene(Page::Conversation, "dm-" + key + "-revoked");
    data.dm_can_read = data.dm_can_send = true; data.has_older = true;
    scene(Page::RecordReady, "dm-" + key + "-record-ready");
    scene(Page::Recording, "dm-" + key + "-recording");
    scene(Page::Transcribing, "dm-" + key + "-transcribing");
    state.draft = "See you at 6:30. Bring a light jacket. I will bring the map. We can take the river path and meet at the bookshop after the walk. Please wait near the main entrance if you arrive first.";
    state.draft += "\n\nPlease wait near the main entrance if you arrive first. We can check the route together and decide where to stop for dinner. Send me a message if the meeting time changes.";
    state.voice = VoicePhase::Review; state.nonce.clear();
    scene(Page::Review, "dm-" + key + "-review");
    actions.clear(); tap_control("Send message"); assert(actions.size() == 1 && actions[0].first == Action::Send);
    auto* review_panel = lv_obj_get_child(lv_scr_act(), 1);
    lv_obj_scroll_to_y(review_panel, lv_obj_get_scroll_bottom(review_panel), LV_ANIM_OFF);
    capture(output + "/dm-" + key + "-review-end.ppm");
    state.voice = VoicePhase::Sending; state.nonce = "dm-preview-intent";
    scene(Page::Review, "dm-" + key + "-sending");
    actions.clear(); tap_control("Sending..."); tap_control(LV_SYMBOL_REFRESH); tap_control(LV_SYMBOL_CLOSE); assert(actions.empty());
    state.voice = VoicePhase::Failed; data.error = "Could not send. Try again.";
    scene(Page::Review, "dm-" + key + "-send-failed");
    actions.clear(); tap_control("Retry message"); assert(actions.size() == 1 && actions[0].first == Action::Retry);
    state.draft.clear(); state.nonce.clear(); data.error = "Could not transcribe. Record again.";
    scene(Page::Review, "dm-" + key + "-no-transcript");
    actions.clear(); tap_control("Send message"); assert(actions.empty());
    data.error.clear(); state.voice = VoicePhase::Empty;
  }
  const std::pair<bool, const char*> member_faces[] = {
    {true, "8278cd34-0324-43dc-8803-906372f8a4d4"},
    {false, "dde46742-b151-4754-874b-f545d6b9b196"},
    {true, "8278cd34-0324-43dc-8803-906372f8a4d4"},
    {false, "dde46742-b151-4754-874b-f545d6b9b196"},
  };
  std::array<const uint8_t*, 2> retained_generated{};
  for (size_t i = 0; i < std::size(member_faces); ++i) {
    state.cancel_draft(); state.select_recipient("motion-peer-" + std::to_string(i));
    state.page = Page::Character;
    data.dm_human = member_faces[i].first; data.bot_custom = false; data.bot_online = false;
    ui.set_seed(member_faces[i].second); ui.show(state, data);
    auto* retained_face = lv_obj_get_child(lv_scr_act(), 1);
    auto* body = lv_obj_get_child(retained_face, 0);
    ui.show(state, data);
    assert(lv_obj_get_child(lv_scr_act(), 1) == retained_face);
    assert(lv_obj_get_child(retained_face, 0) == body);
    lv_refr_now(nullptr);
    const int before_same_refresh = preview_panel_calls;
    ui.show(state, data); lv_refr_now(nullptr);
    assert(preview_panel_calls == before_same_refresh);

    const auto* source = static_cast<const lv_img_dsc_t*>(lv_img_get_src(body));
    if (i < 2) retained_generated[i] = source->data;
    else assert(retained_generated[i % 2] == source->data);
    assert(idle_changes(ui, time));
    auto* face = lv_obj_get_child(lv_scr_act(), 1);
    assert(lv_obj_get_style_radius(face, 0) == LV_RADIUS_CIRCLE);
    assert(!lv_obj_get_style_clip_corner(face, 0));
    assert(pixels[0].full == 0 && pixels[465].full == 0 && pixels[465*466].full == 0 && pixels[466*466-1].full == 0);
    assert(lv_img_get_zoom(body) == 256);
    assert(static_cast<const lv_img_dsc_t*>(lv_img_get_src(body))->header.w == 466);
    auto* clip = lv_obj_get_child(face, 2);
    auto* eyes = lv_obj_get_child(clip, 0);
    auto* mouth = lv_obj_get_child(face, 3);
    assert(lv_obj_has_flag(clip, LV_OBJ_FLAG_HIDDEN));
    assert(lv_obj_has_flag(mouth, LV_OBJ_FLAG_HIDDEN));
    assert(lv_img_get_src(eyes) == nullptr && lv_img_get_src(mouth) == nullptr);
    capture(output + "/member-motion-" + std::to_string(i) + ".ppm");
  }
  for (const char* seed : {"8278cd34-0324-43dc-8803-906372f8a4d4", "dde46742-b151-4754-874b-f545d6b9b196"}) {
    ui.prepare_transition();
    lv_tick_inc(1500);
    ui.set_seed(seed); ui.show(state, data);
    ui.tick(time += 1501); lv_refr_now(nullptr);
    assert(lv_obj_get_child_cnt(lv_layer_top()) == 1);
    auto* overlay = lv_obj_get_child(lv_layer_top(), 0);
    assert(lv_obj_get_style_opa(overlay, 0) == LV_OPA_COVER);
    assert(lv_obj_has_flag(overlay, LV_OBJ_FLAG_CLICKABLE));
    std::array<lv_color_t, 466 * 466> before;
    std::copy(std::begin(pixels), std::end(pixels), before.begin());
    lv_tick_inc(150); lv_timer_handler(); ui.tick(time += 150); lv_refr_now(nullptr);
    const auto middle = lv_obj_get_style_opa(overlay, 0);
    assert(middle > 0 && middle < LV_OPA_COVER);
    bool changed = false;
    for (size_t i = 0; i < before.size(); ++i) changed = changed || pixels[i].full != before[i].full;
    assert(changed);
    ui.show(state, data);
    assert(lv_obj_get_style_opa(overlay, 0) == middle);
    lv_tick_inc(151); lv_timer_handler(); ui.tick(time += 151); lv_refr_now(nullptr);
    assert(lv_obj_get_child_cnt(lv_layer_top()) == 0);
  }
  data.bot_custom = true; data.dm_handle = "Jarvis Photo Sample#6710";
  ui.set_character(nullptr); ui.show(state, data); lv_obj_update_layout(lv_scr_act());
  assert(has_label(lv_scr_act(), "Jarvis Photo Sample#6710"));
  assert(!idle_changes(ui, time));
  auto* fallback_face = lv_obj_get_child(lv_scr_act(), 1);
  auto* fallback = lv_obj_get_child(fallback_face, 1);
  assert(std::abs(lv_obj_get_x(fallback) * 2 + lv_obj_get_width(fallback) - 466) <= 2);
  assert(std::abs(lv_obj_get_y(fallback) * 2 + lv_obj_get_height(fallback) - 466) <= 2);
  std::vector<uint8_t> texture(112 * 112 * 3);
  for (int y = 0; y < 112; ++y) for (int x = 0; x < 112; ++x) {
    auto* target = texture.data() + (y * 112 + x) * 3;
    target[0] = x * 255 / 112; target[1] = y * 255 / 112; target[2] = 64;
  }
  lv_img_dsc_t custom{}; custom.header.cf = LV_IMG_CF_TRUE_COLOR;
  custom.header.w = custom.header.h = 112; custom.data = texture.data(); custom.data_size = texture.size();
  ui.set_character(&custom, texture.data()); ui.show(state, data);
  assert(idle_changes(ui, time));
  auto* sphere = lv_obj_get_child(lv_scr_act(), 1);
  size_t visible = 0;
  for (uint32_t i = 0; i < lv_obj_get_child_cnt(sphere); ++i) visible += !lv_obj_has_flag(lv_obj_get_child(sphere, i), LV_OBJ_FLAG_HIDDEN);
  assert(visible == 1);
  const auto* selected_frame = static_cast<const lv_img_dsc_t*>(lv_img_get_src(lv_obj_get_child(sphere, 0)));
  assert(selected_frame->header.w == 466 && selected_frame->header.cf == LV_IMG_CF_TRUE_COLOR);
  assert(lv_obj_get_style_radius(sphere, 0) == LV_RADIUS_CIRCLE && !lv_obj_get_style_clip_corner(sphere, 0));
  capture(output + "/character-sphere-sample.ppm");
  assert(ui.direct_frame()==nullptr);
  ui.enable_direct_character(true);assert(ui.direct_frame());
  lv_refr_now(nullptr);
  const auto previous_calls=preview_panel_calls;
  ui.tick(time+=100);lv_refr_now(nullptr);
  assert(preview_panel_calls==previous_calls);
  const auto* direct=ui.direct_frame();assert(direct);
  assert(preview_board_present(direct,pixels));
  assert(std::memcmp(pixels,direct->data,direct->data_size)==0);
  std::vector<uint8_t> current(direct->data,direct->data+direct->data_size);
  std::memset(buffer,0xa5,sizeof(buffer));
  ui.prepare_transition();assert(ui.direct_frame()==nullptr);
  auto* transition=lv_obj_get_child(lv_layer_top(),0);
  const auto* snapshot=static_cast<const lv_img_dsc_t*>(lv_img_get_src(transition));
  assert(std::memcmp(snapshot->data,current.data(),current.size())==0);
  ui.tick(time+=100);lv_refr_now(nullptr);
  lv_tick_inc(301);lv_timer_handler();ui.tick(time+=301);lv_refr_now(nullptr);
  assert(ui.direct_frame());
  ui.notify("Choose a DM to record.");assert(ui.direct_frame()==nullptr);
  ui.tick(time+=100);lv_refr_now(nullptr);assert(has_label(lv_scr_act(),"Choose a DM to record."));
  lv_tick_inc(3001);lv_timer_handler();ui.tick(time+=3001);lv_refr_now(nullptr);
  assert(ui.direct_frame());
  ui.set_character(nullptr);ui.show(state,data);assert(ui.direct_frame()==nullptr);
  ui.set_character(&custom,texture.data());ui.show(state,data);assert(ui.direct_frame());
  ui.enable_direct_character(false);assert(ui.direct_frame()==nullptr);
  ui.set_character(nullptr);
  data.bot_custom = false;
  state.page = Page::Conversation; ui.show(state, data);
  settle_transition();
  lv_obj_update_layout(lv_scr_act());
  actions.clear(); swipe(233, 60, 0, 160);
  assert(actions.size() == 1 && actions[0].first == Action::Back);
  actions.clear(); swipe(233, 230, 0, 140);
  assert(std::none_of(actions.begin(), actions.end(), [](const auto& action) { return action.first == Action::Back; }));
  assert(saw_full_flush_with_partial_clip);
  {
    auto* retained = lv_obj_get_child(lv_scr_act(), 1);
    ui.set_character(&custom, texture.data()); state.page = Page::Character; data.bot_custom = true;
    ui.show(state, data); retained = lv_obj_get_child(lv_scr_act(), 1);
    auto* picture = lv_obj_get_child(retained, 0);
    ui.set_character(nullptr);
    assert(lv_img_get_src(picture) == nullptr);
    ui.show(state, data); assert(lv_obj_get_child(lv_scr_act(), 1) == retained);
  }
  std::cout << "Human/BOT member faces move after alternating recipient changes; expressionless custom texture uses the same interpolated sphere canvas without facial overlays.\n";
  {
    Interaction journey;
    journey.sign_in("transition-account"); journey.select_recipient("transition-peer", "transition-dm");
    UiData sample; sample.dm_enabled = true; sample.dm_can_read = sample.dm_can_send = true;
    sample.dm_handle = "Transition#0042";
    ui.show(journey, sample); settle_transition();
    const auto show_transition = [&] {
      ui.show(journey, sample);
      assert(lv_obj_get_child_cnt(lv_layer_top()) == 1);
      auto* overlay = lv_obj_get_child(lv_layer_top(), 0);
      assert(lv_obj_get_style_opa(overlay, 0) == LV_OPA_COVER);
      ui.tick(time += 1);
      lv_tick_inc(150); lv_timer_handler(); ui.tick(time += 150);
      const auto middle = lv_obj_get_style_opa(overlay, 0);
      assert(middle > 0 && middle < LV_OPA_COVER);
      ui.show(journey, sample);
      assert(lv_obj_get_child(lv_layer_top(), 0) == overlay && lv_obj_get_style_opa(overlay, 0) == middle);
      lv_tick_inc(151); lv_timer_handler(); ui.tick(time += 151);
      assert(lv_obj_get_child_cnt(lv_layer_top()) == 0);
    };
    assert(journey.start_recording()); show_transition();
    const auto owner = journey.owner();
    assert(journey.finish_recording()); show_transition();
    assert(journey.transcript(owner, "Private transition draft")); show_transition();
    assert(journey.confirm("transition-nonce"));
    ui.show(journey, sample); assert(lv_obj_get_child_cnt(lv_layer_top()) == 0);
    assert(journey.sent(owner, "transition-nonce")); show_transition();
    assert(journey.start_recording()); show_transition();
    assert(journey.cancel_draft()); show_transition();
    journey.enter(Page::LogoutConfirmation); ui.show(journey, sample); ui.tick(time += 1);
    assert(lv_obj_get_child_cnt(lv_layer_top()) == 1);
    ui.retire_session(); assert(lv_obj_get_child_cnt(lv_layer_top()) == 0);
    journey.sign_out(); sample = {}; ui.show(journey, sample); ui.tick(time += 1);
    assert(lv_obj_get_child_cnt(lv_layer_top()) == 0);
    assert(!has_label(lv_scr_act(), "Private transition draft") && !has_label(lv_scr_act(), "Transition#0042"));
    sample.qr = "WIFI:T:WPA;S:Preview;P:preview-only;;";
    journey.enter(Page::Network); ui.show(journey, sample); settle_transition();
    actions.clear(); tap_control(LV_SYMBOL_CLOSE);
    assert(actions.size() == 1 && actions[0].first == Action::Back);
    actions.clear();
    ui.show(state, data); settle_transition();
    std::cout << "Automatic recording/transcription/review/send/cancel fades, non-restarted refreshes, immediate logout privacy cleanup and Wi-Fi cancel control passed.\n";
  }
  state.page = Page::Home;
  for (int battery : {-1, 0, 20, 21, 50, 51, 100}) for (bool charging : {false, true}) {
    data.battery = battery; data.charging = charging; ui.show(state, data); lv_obj_update_layout(lv_scr_act());
    const auto text = battery < 0 ? "--%" : std::to_string(battery) + "%";
    assert(has_label(lv_scr_act(), text.c_str()));
    assert(has_label(lv_scr_act(), LV_SYMBOL_CHARGE) == charging);
    capture(output + "/battery-" + std::to_string(battery) + (charging ? "-charging" : "") + ".ppm");
    if (battery > 0) {
      const auto expected = lv_color_hex(battery > 50 ? 0x50dc78 : battery > 20 ? 0xffbe3c : 0xf05046);
      assert(pixels[70 * 466 + 301].full == expected.full);
    }
  }
  data.battery = 78; data.charging = false;
  data.firmware_version = "0.1.54"; data.available_version = "0.1.55";
  data.status = "Wi-Fi connected";
  scene(Page::Settings, "settings");
  actions.clear(); tap_control("Update"); assert(actions.size() == 1 && actions[0].first == Action::Update);
  const std::pair<UpdatePhase, const char*> update_samples[] = {
    {UpdatePhase::Idle, "idle"}, {UpdatePhase::Checking, "checking"}, {UpdatePhase::Current, "current"}, {UpdatePhase::Available, "available"}, {UpdatePhase::CheckFailed, "check-failed"}, {UpdatePhase::Installing, "installing"}, {UpdatePhase::Restarting, "restarting"}, {UpdatePhase::InstallFailed, "install-failed"}
  };
  for (const auto& sample : update_samples) {
    data.update_phase = sample.first; data.update_progress = 35;
    data.update_error = sample.first == UpdatePhase::CheckFailed ? "Check Wi-Fi and try again" : sample.first == UpdatePhase::InstallFailed ? "Current firmware is unchanged" : "";
    scene(Page::FirmwareUpdate, std::string("update-") + sample.second);
    actions.clear();
    if (sample.first == UpdatePhase::Available) { tap_control("Update now"); assert(actions.size() == 1 && actions[0].first == Action::InstallUpdate); }
    else if (sample.first == UpdatePhase::Checking) { tap_control("Checking..."); assert(actions.empty()); }
    else if (sample.first == UpdatePhase::Installing || sample.first == UpdatePhase::Restarting) { tap_control(LV_SYMBOL_CLOSE); assert(actions.empty()); }
    else { tap_control("Check for update"); assert(actions.size() == 1 && actions[0].first == Action::CheckUpdate); }
  }
  std::cout << "Native request rows (including 80 actions), gesture routes, menus, history anchors and notice expiry passed.\n";
  lv_obj_clean(lv_scr_act());
  auto rectangle = [](int y) {
    auto* item = lv_obj_create(lv_scr_act()); lv_obj_remove_style_all(item);
    lv_obj_set_pos(item, 100, y); lv_obj_set_size(item, 10, 10);
    lv_obj_set_style_bg_opa(item, LV_OPA_COVER, 0); lv_obj_set_style_bg_color(item, lv_color_white(), 0);
    return item;
  };
  auto* upper = rectangle(20); auto* lower = rectangle(400); lv_refr_now(nullptr);
  preview_panel_calls = 0;
  lv_obj_set_style_bg_color(upper, lv_color_hex(0xff0000), 0);
  lv_obj_set_style_bg_color(lower, lv_color_hex(0xff0000), 0); lv_refr_now(nullptr);
  assert(preview_panel_calls == 1 && preview_panel_y <= 20 && preview_panel_y + preview_panel_height >= 410);
  assert(pixels[25 * 466 + 105].full == lv_color_hex(0xff0000).full);
  assert(pixels[405 * 466 + 105].full == lv_color_hex(0xff0000).full);
  preview_panel_calls = 0;
  lv_obj_set_style_bg_color(upper, lv_color_hex(0x0000ff), 0); lv_refr_now(nullptr);
  assert(preview_panel_calls == 1 && preview_panel_y <= 20 && preview_panel_y + preview_panel_height >= 30 && preview_panel_height < 30);
  assert(pixels[25 * 466 + 105].full == lv_color_hex(0x0000ff).full);
  assert(pixels[405 * 466 + 105].full == lv_color_hex(0xff0000).full);
  std::cout << "Rendered native LVGL preview scenes (sample data; no device or backend).\n";
}
