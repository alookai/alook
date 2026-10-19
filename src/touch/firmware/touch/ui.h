#pragma once
#include "ownership.h"
#include "speaker_motion.h"
#include "avatar.h"
#include "speaker_renderer.h"
#include "history.h"
#include "dm.h"
#include "requests.h"
#include "update_state.h"
#include <lvgl.h>
#include <array>
#include <deque>
#include <functional>
#include <string>
#include <vector>

namespace alook_touch {
enum class Action { SetupNetwork, ManualNetwork, Authorize, Profile, Requests, Bots, Settings, Logout, ConfirmLogout, Chat, AdjacentBot, Send, Retry, Rerecord, Cancel, AddFriend, AcceptFriend, AcceptRequest, Back, Brightness, Older, Newer, Latest, Dms, OpenDm, Update, CheckUpdate, InstallUpdate };
struct BotItem { std::string id; std::string name; std::string handle; std::string image; bool online = false; };
struct ControlLocation { std::string label; Action action; int argument; int x; int y; int width; int height; bool disabled; bool long_press; };
struct UiData : UpdateData {
  bool ble_setup = false;
  bool dm_enabled = false;
  bool dms_loaded = false;
  bool dm_human = false;
  bool dm_can_read = true;
  bool dm_can_send = true;
  std::vector<DmItem> dms;
  std::string dm_handle;
  std::string dm_id;
  std::string dm_error;
  std::string status;
  std::string qr;
  std::string short_code;
  std::string human_name;
  std::string human_handle;
  std::string bot_name;
  std::string peer_name;
  std::string peer_handle;
  std::string peer_state;
  std::string error;
  std::vector<BotItem> bots;
  std::vector<MessageItem> messages;
  std::vector<FriendRequestItem> requests;
  std::string request_busy;
  std::string requests_error;
  bool requests_loaded = false;
  uint32_t face_color = 0x32c2b9;
  int battery = -1;
  bool charging = false;
  bool has_older = false;
  bool has_newer = false;
  bool new_messages = false;
  bool bot_custom = false;
  bool human_custom = false;
  bool peer_custom = false;
  bool bot_online = false;
  bool bots_loaded = false;
};
class Ui {
public:
  void begin(std::function<void(Action, int)> handler);
  void show(const Interaction& state, const UiData& data);
  void tick(uint32_t now);
  void enable_direct_character(bool enabled) { direct_character_enabled_ = enabled; }
  const lv_img_dsc_t* direct_frame() const;
  void set_character(const lv_img_dsc_t* image, const uint8_t* texture = nullptr);
  void set_seed(const std::string& seed);
  void prepare_transition();
  void retire_session();
  void set_human_seed(const std::string& seed);
  void set_peer_seed(const std::string& seed);
  void set_human_image(const lv_img_dsc_t* image);
  void set_peer_image(const lv_img_dsc_t* image);
  bool reading_latest() const;
  void scroll_to_latest();
  void notify(const std::string& text);
  std::string reading_anchor() const;
  void refresh_conversation(const Interaction& state, const UiData& data, bool preserve);
  std::vector<ControlLocation> controls() const;
private:
  struct Binding { Ui* self; Action action; int argument; lv_obj_t* object = nullptr; bool long_press = false; };
  std::deque<Binding> bindings_;
  std::function<void(Action, int)> handler_;
  Page page_ = Page::Startup;
  lv_obj_t* screen_ = nullptr;
  lv_obj_t* history_ = nullptr;
  lv_obj_t* latest_ = nullptr;
  lv_obj_t* notice_ = nullptr;
  uint32_t notice_until_ = 0;
  bool history_has_older_ = false;
  bool history_has_newer_ = false;
  bool user_scrolling_ = false;
  int scroll_direction_ = 0;
  int history_edge_ = 0;
  lv_obj_t* character_ = nullptr;
  lv_obj_t* character_body_ = nullptr;
  lv_obj_t* character_fallback_ = nullptr;
  lv_obj_t* character_glow_ = nullptr;
  const lv_img_dsc_t* shown_character_ = nullptr;
  std::string shown_seed_;
  const uint8_t* texture_ = nullptr;
  SpeakerRenderer speaker_;
  bool generated_character_ = false;
  bool direct_character_enabled_ = false;
  int turn_frame_ = 3;
  lv_obj_t* eyes_ = nullptr;
  lv_obj_t* eye_clip_ = nullptr;
  lv_obj_t* mouth_ = nullptr;
  int eye_x_ = 0;
  int eye_y_ = 0;
  int eye_height_ = 0;
  int eye_width_ = 0;
  int mouth_x_ = 0;
  int mouth_y_ = 0;
  int mouth_width_ = 0, mouth_height_ = 0;
  int eye_pixels_ = 0, mouth_pixels_ = 0;
  AvatarArt art_;
  FeatureArt eyes_art_;
  FeatureArt mouth_art_;
  FeatureArt glow_art_;
  AvatarArt cached_art_;
  FeatureArt cached_eyes_art_, cached_mouth_art_;
  std::string cached_seed_;
  AvatarArt human_art_;
  AvatarArt peer_art_;
  const lv_img_dsc_t* human_image_ = nullptr;
  const lv_img_dsc_t* peer_image_ = nullptr;
  std::vector<std::string> message_ids_;
  const lv_img_dsc_t* image_ = nullptr;
  lv_obj_t* title_ = nullptr;
  std::array<lv_obj_t*, 3> bubbles_{};
  SpeakerMenu menu_;
  SpeakerIdle idle_;
  uint32_t last_frame_ = 0;
  std::string seed_;
  lv_img_dsc_t* transition_snapshot_ = nullptr;
  lv_obj_t* transition_image_ = nullptr;
  bool transition_started_ = false;
  bool suppress_transition_ = false;
  void clear_transition();
  lv_obj_t* label(lv_obj_t* parent, const std::string& text, int width);
  lv_obj_t* button(lv_obj_t* parent, const std::string& text, Action action, int argument = 0);
  lv_obj_t* icon_button(lv_obj_t* parent, const char* symbol, Action action);
  void base(const std::string& title);
  void qr(const std::string& content);
  void highlight(lv_obj_t* item, uint32_t color);
  lv_obj_t* avatar(lv_obj_t* parent, AvatarArt& art, const lv_img_dsc_t* image, bool custom, int diameter);
  static void clicked(lv_event_t* event);
  static void history_scrolled(lv_event_t* event);
  void update_history_arrow();
  bool show_dm_page(const Interaction& state, const UiData& data);
};
}
