#include "application.h"
#include "usb_mirror.h"
#include "board.h"
#include "configuration.h"
#include "dm_protocol.h"
#include "requests_protocol.h"
#include "update_protocol.h"
#include "generated/build_info.h"
#include <WiFi.h>
#include <esp_system.h>
#include <algorithm>
#include <ctime>

namespace alook_touch {
namespace {
std::string encode(const std::string& value) {
  constexpr char hex[] = "0123456789ABCDEF";
  std::string out;
  for (uint8_t c : value) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}
std::string json(const JsonDocument& document) { std::string out; serializeJson(document, out); return out; }
std::string random_id() { char out[33]; for (int i = 0; i < 4; ++i) snprintf(out + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random())); return out; }
std::string error_text(const JsonDocument& document, int status) {
  const char* text = document["error"]["message"] | document["error"].as<const char*>();
  if (text && strlen(text) < 300) return text;
  return status == 0 ? "Connection failed. Try again." : status >= 500 ? "Service unavailable. Try again." : "This action is unavailable.";
}
bool success(int status) { return status >= 200 && status < 300; }
}

bool Application::begin() {
  boot_ = millis();
  data_.dm_enabled = true; data_.dm_can_read = data_.dm_can_send = false;
  if (!storage_.begin()) return false;
  board_brightness(storage_.brightness());
  session_ = storage_.read();
  const uint64_t chip = ESP.getEfuseMac();
  char identity[32]; snprintf(identity, sizeof(identity), "AlookTouch/%06lx", static_cast<unsigned long>(chip & 0xffffff));
  device_name_ = std::string(identity) + " firmware/" + firmware_version + " source/" + firmware_source + (firmware_dirty ? "-dirty" : "");
  data_.firmware_version = firmware_version;
  hotspot_ = std::string("Alook-touch-") + std::string(identity).substr(11);
  hotspot_password_ = random_id().substr(0, 10);
  char ble_name[19]; snprintf(ble_name, sizeof(ble_name), "ALOOK_TOUCH_%06lX", static_cast<unsigned long>(chip & 0xffffff));
  ble_name_ = ble_name;
  if (!network_.begin(device_name_)) return false;
  ui_.enable_direct_character(true);
  ui_.begin([this](Action a, int i) { action(a, i); });
  ui_.set_seed("alook-touch");
  ui_.show(state_, data_);
  provisioning_.setConfigPortalBlocking(false);
  provisioning_.setConfigPortalTimeout(300);
  provisioning_.setConnectTimeout(8);
  provisioning_.setDebugOutput(false);
  provisioning_.setTitle("Alook touch Wi-Fi");
  std::vector<const char*> menu{"wifi", "exit"};
  provisioning_.setMenu(menu);
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin();
  return true;
}

void Application::render() {
  data_.battery = board_battery(); data_.charging = board_charging();
  if (state_.page == Page::Conversation) ui_.refresh_conversation(state_, data_, preserve_history_);
  else ui_.show(state_, data_);
  preserve_history_ = false;
}
bool Application::request(Operation operation, const std::string& method, const std::string& path, const std::string& body, const std::string& target, std::shared_ptr<AudioClip> audio, bool show_failure) {
  const auto index = static_cast<size_t>(operation);
  const bool socket = operation == Operation::SocketStart || operation == Operation::SocketStop;
  const auto id = socket ? 0 : pending_.start(index, state_.owner(), target);
  if (!socket && !id) return false;
  Request command{operation}; command.owner = state_.owner(); command.method = method; command.path = path; command.body = body;
  command.token = operation == Operation::Authorize || operation == Operation::PollAuthorization ? "" : session_.token;
  command.target = target; command.audio = std::move(audio);
  command.id = id;
  if (!network_.submit(std::move(command))) {
    if (id) pending_.complete(index, id);
    if (operation == Operation::Dms) data_.dm_error = "Connection busy. Refresh to try again.";
    else data_.error = "Connection busy. Try again.";
    if (show_failure) render();
    return false;
  }
  return true;
}
void Application::leave_profile() {
  nearby_.stop();
  broadcast_handle_.clear(); peer_code_.clear(); peer_id_.clear(); friendship_.clear();
  ui_.set_peer_image(nullptr); peer_image_.clear(); peer_avatar_.clear();
  data_.peer_name.clear(); data_.peer_handle.clear(); data_.peer_state.clear();
  data_.request_busy.clear(); requests_at_ = 0;
}
void Application::enter(Page page) {
  const bool new_profile = page == Page::Profile && state_.page != Page::Profile;
  if (state_.page == Page::Profile && page != Page::Profile) leave_profile();
  state_.enter(page);
  data_.error.clear();
  if (new_profile) {
    data_.requests.clear(); data_.requests_loaded = false; data_.requests_error.clear(); data_.request_busy.clear();
    refresh_requests();
  }
  render();
}
void Application::refresh_requests() {
  if (!state_.authenticated || state_.page != Page::Profile) return;
  if (!online_) { data_.requests_error = "Offline. Reconnect to load requests."; return; }
  if (request(Operation::RequestList, "GET", "/api/community/friends/pending")) requests_at_ = millis();
}
void Application::retire_session(bool revoke, bool keep_setup) {
  if (!keep_setup) { ble_setup_.stop(); ble_pending_ = ble_configured_ = false; }
  else ble_setup_.clear_code();
  ui_.retire_session();
  if (portal_) { provisioning_.stopConfigPortal(); portal_ = false; }
  leave_profile(); audio_.cancel();
  const auto old = session_.token;
  state_.sign_out(); network_.retire(state_.owner().account); pending_.retire();
  if (revoke && !old.empty()) {
    Request logout{Operation::Logout}; logout.owner = state_.owner(); logout.method = "POST"; logout.path = "/api/auth/sign-out"; logout.body = "{}"; logout.token = old;
    network_.submit(std::move(logout));
  }
  request(Operation::SocketStop, "", "");
  storage_.clear(); session_ = {}; data_ = {}; data_.dm_enabled = true; data_.dm_can_read = data_.dm_can_send = false; state_.channel_id.clear(); older_cursor_.clear(); newer_cursor_.clear();
  data_.firmware_version = firmware_version; update_manifest_.clear(); update_tag_.clear(); restart_at_ = 0;
  ui_.set_character(nullptr); ui_.set_human_image(nullptr); ui_.set_peer_image(nullptr);
  bot_image_.clear(); cached_bot_recipient_.clear(); cached_bot_source_.clear(); human_image_.clear(); peer_image_.clear(); human_avatar_.clear(); peer_avatar_.clear();
  device_code_.clear(); auth_lifetime_ = 0; checking_session_ = false; read_seq_ = requested_read_seq_ = 0;
  ui_.set_seed("alook-touch");
  data_.ble_setup = keep_setup && ble_setup_.active();
  if (data_.ble_setup) data_.qr = ble_setup_.qr();
  data_.status = "Authorize this touch on your phone";
  render();
}
void Application::authorize() {
  retire_session(false, ble_setup_.active());
  JsonDocument body; body["client_id"] = client_id;
  data_.status = "Getting an authorization code…";
  request(Operation::Authorize, "POST", "/api/auth/device/code", json(body)); render();
}
void Application::validate_session() {
  checking_session_ = !state_.authenticated || state_.page == Page::Authorization;
  validated_at_ = millis();
  request(Operation::Profile, "GET", "/api/community/users/me/profile");
}
void Application::start_network_setup(bool manual) {
  if (state_.voice != VoicePhase::Empty) { audio_.cancel(); state_.cancel_draft(); }
  leave_profile();
  device_code_.clear(); auth_lifetime_ = 0;
  network_attempted_ = true;
  if (portal_) provisioning_.stopConfigPortal();
  portal_ = false; ble_setup_.stop(); ble_pending_ = ble_configured_ = false;
  state_.enter(Page::Network);
  data_.error.clear(); data_.qr.clear(); data_.short_code.clear(); data_.ble_setup = !manual;
  if (!manual) {
    ble_pending_ = true; data_.status = "Preparing secure Bluetooth setup…"; render(); return;
  }
  provisioning_.startConfigPortal(hotspot_.c_str(), hotspot_password_.c_str());
  portal_ = provisioning_.getConfigPortalActive();
  state_.enter(Page::Network);
  data_.error.clear();
  if (!portal_) { finish_network_setup(); data_.error = "Could not open Wi-Fi setup. Try again."; render(); return; }
  data_.qr = "WIFI:T:WPA;S:" + hotspot_ + ";P:" + hotspot_password_ + ";;";
  data_.short_code = "192.168.4.1";
  data_.status = "Scan to join touch Wi-Fi\nOpen the address below";
  render();
}
void Application::finish_network_setup() {
  const bool was_ble = data_.ble_setup;
  ble_setup_.stop(); ble_pending_ = ble_configured_ = false; data_.ble_setup = false;
  if (was_ble) { device_code_.clear(); auth_lifetime_ = 0; pending_.retire(); }
  if (portal_) provisioning_.stopConfigPortal();
  portal_ = false;
  if (state_.page != Page::Network && !(was_ble && state_.page == Page::Authorization)) return;
  data_.qr.clear(); data_.short_code.clear(); data_.error.clear();
  if (state_.authenticated) {
    data_.status = std::string("Wi-Fi: ") + (online_ ? "connected" : "offline");
    enter(Page::Settings);
  } else {
    state_.page = Page::Network;
    data_.status = online_ ? "Wi-Fi connected. Checking the clock…" : "Wi-Fi setup closed. Tap Wi-Fi setup to retry.";
    render();
  }
}
void Application::tick_network_setup(uint32_t now) {
  if (ble_pending_ && nearby_.release()) {
    ble_pending_ = false;
    if (!ble_setup_.start(ble_name_)) { finish_network_setup(); data_.error = "Could not open Bluetooth setup. Retry or use Manual Wi-Fi."; render(); return; }
    data_.qr = ble_setup_.qr(); data_.status = "Alook > Settings > Devices\nAdd Touch, then scan"; render();
  }
  if (!ble_setup_.active()) return;
  if (ble_setup_.take_failure()) { data_.error = "Wi-Fi connection failed. Try another network or password on your phone."; render(); }
  if (ble_setup_.take_configured()) { ble_configured_ = true; data_.error.clear(); data_.status = "Wi-Fi connected. Checking the clock…"; render(); }
  ble_setup_.tick(now);
  if (!ble_setup_.active()) {
    data_.ble_setup = false; data_.qr.clear();
    if (device_code_.empty()) finish_network_setup();
    else { data_.status = "Continue on your phone\nCheck this code, then approve"; render(); }
    return;
  }
  if (ble_configured_ && state_.page == Page::Network && online_ && time(nullptr) > 1700000000) authorize();
}
void Application::clear_dm() {
  state_.invalidate_recipient(true);
  data_.dm_id.clear(); data_.dm_handle.clear(); data_.bot_name.clear();
  data_.messages.clear(); data_.has_older = data_.has_newer = data_.new_messages = false;
  data_.dm_can_read = data_.dm_can_send = data_.bot_online = false;
  older_cursor_.clear(); newer_cursor_.clear(); read_seq_ = requested_read_seq_ = 0;
  ui_.set_character(nullptr); bot_image_.clear(); cached_bot_recipient_.clear(); cached_bot_source_.clear();
}
void Application::clear_dm_access() {
  const bool interrupted = state_.voice != VoicePhase::Empty;
  state_.invalidate_recipient(); audio_.cancel();
  data_.dm_can_read = data_.dm_can_send = false; data_.messages.clear();
  data_.has_older = data_.has_newer = data_.new_messages = false;
  older_cursor_.clear(); newer_cursor_.clear();
  if (interrupted) state_.enter(Page::Conversation);
}
void Application::refresh_dms() {
  if (request(Operation::Dms, "GET", "/api/community/users/me/dms", "", "", nullptr, state_.page == Page::DmList)) { dms_at_ = millis(); data_.dm_error.clear(); }
}
void Application::refresh_dm() {
  if (state_.channel_id.empty()) return;
  const auto channel = state_.channel_id;
  if (request(Operation::OpenDm, "GET", "/api/community/channels/" + encode(channel), "", channel)) metadata_at_ = millis();
  request(Operation::DmProfile, "GET", "/api/community/users/" + encode(state_.recipient_id) + "/profile", "", state_.recipient_id);
}
void Application::select_dm(size_t index) {
  if (index >= data_.dms.size()) return;
#if ALOOK_TOUCH_USB_MIRROR
  const auto preparation_started = millis();
#endif
  const auto dm = data_.dms[index];
  const bool changed = state_.channel_id != dm.id || state_.recipient_id != dm.user_id;
  if (!state_.select_recipient(dm.user_id, dm.id)) return;
  leave_profile();
  if (changed) {
    ui_.prepare_transition();
    data_.messages.clear(); data_.has_older = data_.has_newer = data_.new_messages = false;
    data_.dm_can_read = data_.dm_can_send = false;
    older_cursor_.clear(); newer_cursor_.clear(); read_seq_ = requested_read_seq_ = 0;
    ui_.set_character(nullptr);
  }
  data_.dm_id = dm.id; data_.dm_handle = dm.handle; data_.dm_human = !dm.identity_known || dm.human;
  data_.bot_name = dm.handle; data_.bot_online = online_ && dm.online;
  session_.channel = dm.id; storage_.save(session_);
  const bool generated = dm.image.compare(0, 12, "avatar:beam:") == 0;
  data_.bot_custom = !dm.image.empty() && !generated && (dm.image.front() == '/' || dm.image.compare(0, 8, "https://") == 0);
  if (data_.bot_custom) {
    const bool cached = bot_image_.image() && cached_bot_recipient_ == dm.user_id && cached_bot_source_ == dm.image;
    ui_.set_character(cached ? bot_image_.image() : nullptr, cached ? bot_image_.texture() : nullptr);
    if (!cached) {
      bot_image_.clear(); cached_bot_recipient_.clear(); cached_bot_source_.clear();
      request(Operation::AvatarBot, "GET", dm.image, "", dm.user_id);
    }
  } else { ui_.set_character(nullptr); ui_.set_seed(generated ? dm.image.substr(12) : dm.user_id); }
  data_.error.clear(); data_.status = online_ ? "" : "Offline";
  refresh_dm(); render();
#if ALOOK_TOUCH_USB_MIRROR
  usb_mirror_work(false, millis() - preparation_started);
#endif
}
void Application::request_history(const std::string& window, const std::string& cursor) {
  if (state_.channel_id.empty() || !state_.authenticated || !data_.dm_can_read) return;
  std::string path = "/api/community/channels/" + encode(state_.channel_id) + "/messages?limit=20&window=" + window;
  if (!cursor.empty()) path += window == "around" ? "&anchor=" + encode(cursor) : "&cursor=" + encode(cursor);
  if (request(Operation::History, "GET", path, "", window)) { history_at_ = millis(); history_dirty_ = false; }
}
void Application::recording_start() {
  if (data_.update_phase == UpdatePhase::Installing || data_.update_phase == UpdatePhase::Restarting) return;
  const std::string blocker = !state_.authenticated ? "Sign in before recording." : portal_ || data_.ble_setup || state_.page == Page::Network ? "Finish Wi-Fi setup before recording." : !online_ ? "Connect Wi-Fi to record." : state_.recipient_id.empty() ? "Choose a DM to record." : !data_.dm_can_send ? "Sending is unavailable in this DM." : state_.channel_id.empty() ? "Open Chat before recording." : "";
  if (!blocker.empty()) {
    data_.error.clear(); ui_.notify(blocker); return;
  }
  if (!state_.start_recording()) return;
  data_.error.clear();
  leave_profile();
  if (!audio_.start()) { state_.finish_recording(); state_.transcript(state_.owner(), ""); data_.error = "Microphone unavailable. Record again."; }
  render();
}
void Application::recording_finish() {
  if (!state_.finish_recording()) return;
  auto audio = audio_.finish();
  if (!audio) { state_.transcript(state_.owner(), ""); data_.error = "Recording is too short. Record again."; }
  else if (!request(Operation::Transcribe, "POST", "/api/audio/transcriptions", "", state_.recipient_id, std::move(audio))) {
    state_.transcript(state_.owner(), ""); data_.error = "Could not start transcription. Record again.";
  }
  render();
}
void Application::send() {
  if (!data_.dm_can_send || state_.channel_id.empty()) { state_.failed_send(state_.owner()); data_.error = "Sending is unavailable in this DM."; render(); return; }
  JsonDocument body; body["content"] = state_.draft; body["nonce"] = state_.nonce;
  if (!request(Operation::Send, "POST", "/api/community/channels/" + encode(state_.channel_id) + "/messages", json(body), state_.channel_id)) state_.failed_send(state_.owner());
  render();
}
void Application::action(Action command, int argument) {
  if (data_.update_phase == UpdatePhase::Installing || data_.update_phase == UpdatePhase::Restarting) return;
  if (command == Action::Cancel && state_.voice != VoicePhase::Sending) {
    audio_.cancel(); state_.cancel_draft(); data_.error.clear(); render(); return;
  }
  if (command == Action::Rerecord) {
    if (state_.prepare_recording()) { audio_.cancel(); data_.error.clear(); render(); }
    return;
  }
  if (command == Action::Send) { if (state_.confirm(random_id())) send(); return; }
  if (command == Action::Retry) { if (state_.retry()) send(); return; }
  if (state_.voice != VoicePhase::Empty) return;
  switch (command) {
    case Action::SetupNetwork: start_network_setup(); break;
    case Action::ManualNetwork: start_network_setup(true); break;
    case Action::Authorize: if (online_ && (!data_.ble_setup || ble_configured_)) authorize(); else start_network_setup(); break;
    case Action::Profile: enter(Page::Profile); break;
    case Action::Requests:
      if (state_.show_requests()) { leave_profile(); data_.error.clear(); refresh_requests(); render(); }
      break;
    case Action::AcceptRequest:
      if (state_.page == Page::Profile && argument >= 0 && static_cast<size_t>(argument) < data_.requests.size() && data_.request_busy.empty()) {
        if (!online_) { data_.requests_error = "Offline. Reconnect to accept this request."; render(); break; }
        const auto& row = data_.requests[argument];
        if (row.kind == "incoming" && !row.needs_owner_approval) {
          data_.requests_error.clear();
          if (request(Operation::AcceptRequest, "POST", "/api/community/friends/" + encode(row.id) + "/accept", "{}", row.id, nullptr, true)) {
            data_.request_busy = row.id; render();
          }
        }
      }
      break;
    case Action::Bots:
    case Action::Dms:
      enter(Page::DmList); refresh_dms(); render(); break;
    case Action::OpenDm:
      if (argument >= 0) select_dm(static_cast<size_t>(argument));
      break;
    case Action::Settings: data_.status = "Wi-Fi: " + std::string(online_ ? "connected" : "offline") + "\n" + device_name_.substr(0, device_name_.find(' ')); enter(Page::Settings); break;
    case Action::Update: enter(Page::FirmwareUpdate); break;
    case Action::CheckUpdate:
      if (state_.page == Page::FirmwareUpdate && data_.update_phase != UpdatePhase::Checking) {
        update_manifest_.clear(); update_tag_.clear(); data_.available_version.clear(); data_.update_error.clear();
        if (online_ && request(Operation::UpdateCheck, "GET", "")) data_.update_phase = UpdatePhase::Checking;
        else { data_.update_phase = UpdatePhase::CheckFailed; data_.update_error = "Connect to Wi-Fi and try again."; }
        render();
      }
      break;
    case Action::InstallUpdate:
      if (state_.page == Page::FirmwareUpdate && data_.update_phase == UpdatePhase::Available && !update_manifest_.empty()) {
        if (online_ && request(Operation::UpdateInstall, "GET", "", update_manifest_, update_tag_)) { data_.update_phase = UpdatePhase::Installing; data_.update_progress = 0; }
        else { data_.update_phase = UpdatePhase::InstallFailed; data_.update_error = "Connect to Wi-Fi and check again."; }
        render();
      }
      break;
    case Action::Logout: enter(Page::LogoutConfirmation); break;
    case Action::ConfirmLogout: retire_session(true); break;
    case Action::AdjacentBot: {
      if (state_.page != Page::Character) break;
      if (data_.dms.empty()) { action(Action::Dms, 0); break; }
      const auto current = std::find_if(data_.dms.begin(), data_.dms.end(), [&](const auto& dm) { return dm.id == state_.channel_id; });
      if (current == data_.dms.end()) { action(Action::Dms, 0); break; }
      if (data_.dms.size() == 1) break;
      const size_t index = current - data_.dms.begin();
      select_dm(argument > 0 ? (index + 1) % data_.dms.size() : (index + data_.dms.size() - 1) % data_.dms.size());
      break;
    }
    case Action::Chat: {
      if (state_.channel_id.empty()) { action(Action::Dms, 0); break; }
      enter(Page::Conversation); refresh_dm();
      if (data_.dm_can_read) request_history();
      break;
    }
    case Action::Older: if (!older_cursor_.empty()) request_history("before", older_cursor_); break;
    case Action::Newer: if (!newer_cursor_.empty()) request_history("after", newer_cursor_); break;
    case Action::Latest: if (data_.has_newer) request_history(); else ui_.scroll_to_latest(); break;
    case Action::AddFriend: {
      if (state_.page != Page::Profile || peer_id_.empty() || nearby_.peer() != peer_code_) break;
      JsonDocument body; body["userId"] = peer_id_;
      request(Operation::Friend, "POST", "/api/community/friends/request", json(body), peer_code_, nullptr, true); break;
    }
    case Action::AcceptFriend:
      if (state_.page == Page::Profile && !friendship_.empty() && nearby_.peer() == peer_code_) request(Operation::AcceptFriend, "POST", "/api/community/friends/" + encode(friendship_) + "/accept", "{}", peer_code_, nullptr, true);
      break;
    case Action::Brightness: { const uint8_t value = storage_.brightness() >= 220 ? 80 : storage_.brightness() + 40; storage_.brightness(value); board_brightness(value); break; }
    case Action::Back:
      if (state_.page == Page::Network || data_.ble_setup) finish_network_setup();
      else if (state_.back()) { data_.error.clear(); render(); }
      break;
    default: break;
  }
}

void Application::response(Response result) {
  if (result.owner.account != state_.owner().account) return;
  if (result.id && !pending_.complete(static_cast<size_t>(result.operation), result.id)) return;
  if ((result.operation == Operation::Authorize || result.operation == Operation::PollAuthorization) && state_.page != Page::Authorization) return;
  if (result.operation == Operation::Profile && !state_.authenticated && state_.page == Page::Network) return;
  if (result.operation == Operation::UpdateProgress) {
    if (state_.page == Page::FirmwareUpdate && data_.update_phase == UpdatePhase::Installing && result.target == update_tag_) { data_.update_progress = std::max(0, std::min(100, result.status)); render(); }
    return;
  }
  if (result.operation == Operation::UpdateCheck || result.operation == Operation::UpdateInstall) {
    data_.update_error.clear();
    if (result.operation == Operation::UpdateInstall) {
      if (state_.page != Page::FirmwareUpdate) return;
      if (success(result.status) && result.target == update_tag_) { data_.update_phase = UpdatePhase::Restarting; restart_at_ = millis() + 1200; }
      else { data_.update_phase = UpdatePhase::InstallFailed; data_.update_error = "Update failed. Firmware is unchanged. Check again."; }
    } else {
      JsonDocument document;
      const bool parsed = !deserializeJson(document, result.body);
      if (finish_update_check(data_, success(result.status) && parsed, document.as<JsonVariantConst>(), result.target, firmware_version, hardware_id, partition_layout) && data_.update_phase == UpdatePhase::Available) { update_manifest_ = std::move(result.body); update_tag_ = result.target; }
      else { update_manifest_.clear(); update_tag_.clear(); }
    }
    if (state_.page == Page::FirmwareUpdate) render();
    return;
  }
  if (result.operation == Operation::SocketReady) { data_.status = "Connected"; history_dirty_ = true; refresh_dms(); refresh_dm(); request(Operation::Presence, "GET", "/api/community/friends/presence"); return; }
  if (result.operation == Operation::SocketChanged) {
    JsonDocument event;
    if (!deserializeJson(event, result.body) && event["type"] == "community:presence.update" && event["online"].is<bool>()) {
      for (auto& dm : data_.dms) if (event["userId"] == dm.user_id) {
        dm.online = event["online"].as<bool>();
        if (dm.id == state_.channel_id) data_.bot_online = online_ && dm.online;
      }
      if (state_.page == Page::Character && state_.voice == VoicePhase::Empty) render();
    }
    history_dirty_ = true; resolved_at_ = 0; requests_at_ = 0; return;
  }
  if (result.operation == Operation::SocketClosed) { retire_presence(data_.dms); data_.bot_online = false; data_.status = "Reconnecting…"; if (state_.page == Page::Character && state_.voice == VoicePhase::Empty) render(); return; }
  if (result.operation == Operation::Logout) return;
  const bool avatar_operation = result.operation == Operation::AvatarBot || result.operation == Operation::AvatarHuman || result.operation == Operation::AvatarPeer;
  if (result.status == 401 && !avatar_operation && result.operation != Operation::Authorize && result.operation != Operation::PollAuthorization) {
    retire_session(false); data_.error = "Your session expired or was revoked. Authorize again."; render(); return;
  }
  const bool recipient_operation = result.operation == Operation::DmProfile || result.operation == Operation::History || result.operation == Operation::OpenDm || result.operation == Operation::Send || result.operation == Operation::Read || result.operation == Operation::Transcribe || result.operation == Operation::AvatarBot;
  if (recipient_operation && !state_.accepts_recipient(result.owner)) return;
  const bool request_operation = result.operation == Operation::RequestList || result.operation == Operation::AcceptRequest;
  if (request_operation && !state_.accepts_profile(result.owner)) return;
  if (result.operation == Operation::AcceptRequest && result.target != data_.request_busy) return;
  const bool profile_operation = result.operation == Operation::LookupPeer || result.operation == Operation::PeerProfile || result.operation == Operation::FriendsPending || result.operation == Operation::FriendsAccepted || result.operation == Operation::Friend || result.operation == Operation::AcceptFriend || result.operation == Operation::AvatarPeer;
  if (profile_operation && !state_.accepts_profile(result.owner)) return;
  if (profile_operation
    && (result.target != peer_code_ || nearby_.peer() != peer_code_)) return;
  if (avatar_operation) {
    std::string expected;
    if (result.operation == Operation::AvatarBot) {
      for (const auto& dm : data_.dms) if (dm.id == state_.channel_id && dm.user_id == result.target) expected = dm.image;
    } else expected = result.operation == Operation::AvatarHuman ? human_avatar_ : peer_avatar_;
    if (result.image_source != expected) return;
    const bool decoded = success(result.status) && result.avatar;
    if (decoded) {
      if (result.operation == Operation::AvatarBot && result.target == state_.recipient_id) {
        if (state_.page == Page::Character && state_.voice == VoicePhase::Empty) ui_.prepare_transition();
        ui_.set_character(nullptr); bot_image_.set(std::move(result.avatar));
        cached_bot_recipient_ = result.target; cached_bot_source_ = result.image_source;
        ui_.set_character(bot_image_.image(), bot_image_.texture());
      }
      if (result.operation == Operation::AvatarHuman && result.target == state_.user_id) { ui_.set_human_image(nullptr); human_image_.set(std::move(result.avatar)); ui_.set_human_image(human_image_.image()); }
      if (result.operation == Operation::AvatarPeer) { ui_.set_peer_image(nullptr); peer_image_.set(std::move(result.avatar)); ui_.set_peer_image(peer_image_.image()); }
    } else data_.error = "Avatar unavailable. Supported images: PNG, JPEG, WebP, GIF up to 1024px / 512 KiB.";
    if (state_.voice == VoicePhase::Empty && (state_.page == Page::Character || state_.page == Page::Profile)) render();
    return;
  }
  JsonDocument document(&json_allocator_);
  const bool parsed = !deserializeJson(document, result.body);
  const bool background_dms = result.operation == Operation::Dms && state_.page != Page::DmList;
  if (!success(result.status) || !parsed) {
    if (request_operation) {
      if (result.operation == Operation::AcceptRequest) data_.request_busy.clear();
      data_.requests_error = result.operation == Operation::AcceptRequest ? "Could not accept request. Try again." : "Could not load requests. Reconnect to retry.";
      render(); return;
    }
    if (result.operation == Operation::Dms) { data_.dm_error = "Could not load DMs. Refresh to try again."; if (!background_dms) render(); return; }
    if (result.operation == Operation::Presence) { retire_presence(data_.dms); data_.bot_online = false; if (state_.page == Page::Character && state_.voice == VoicePhase::Empty) render(); return; }
    if (result.operation == Operation::OpenDm || (result.operation == Operation::History && result.status == 403)) {
      clear_dm_access();
    }
    if (result.operation == Operation::PollAuthorization && parsed) {
      const std::string error = document["error"] | "";
      if (error == "authorization_pending") return;
      if (error == "slow_down") { auth_interval_ += 5000; auth_next_ = millis() + auth_interval_; return; }
      device_code_.clear(); ble_setup_.clear_code(); if (!data_.ble_setup) data_.qr.clear(); data_.short_code.clear(); data_.error = error == "access_denied" ? "Authorization denied. Get a new code." : "Code expired. Get a new code."; render(); return;
    }
    if (result.operation == Operation::History && result.target == "around" && result.status == 404) { request_history(); data_.error = "Earlier message unavailable. Showing latest."; render(); return; }
    if (result.operation == Operation::Transcribe) state_.transcript(result.owner, "");
    if (result.operation == Operation::Send) state_.failed_send(result.owner);
    data_.error = parsed ? error_text(document, result.status) : "Could not read the response. Try again.";
    preserve_history_ = state_.page == Page::Conversation; render(); return;
  }
  if (!background_dms) data_.error.clear();
  switch (result.operation) {
    case Operation::RequestList:
      if (read_requests(document.as<JsonVariantConst>(), data_.requests)) { data_.requests_loaded = true; data_.requests_error.clear(); }
      else data_.requests_error = "Could not load requests. Reconnect to retry.";
      break;
    case Operation::AcceptRequest:
      data_.request_busy.clear();
      if (accepted_request(document.as<JsonVariantConst>(), result.target, state_.user_id)) {
        data_.requests.erase(std::remove_if(data_.requests.begin(), data_.requests.end(), [&](const auto& row) { return row.id == result.target; }), data_.requests.end());
        data_.requests_error.clear(); resolved_at_ = 0;
      } else data_.requests_error = "Could not confirm acceptance. Refreshing requests.";
      refresh_requests();
      break;
    case Operation::Authorize: {
      device_code_ = document["device_code"] | "";
      const std::string verification = document["verification_uri_complete"] | "";
      if (device_code_.empty() || verification.empty()) { data_.error = "Authorization code unavailable"; break; }
      if (!data_.ble_setup) data_.qr = verification.front() == '/' ? std::string(origin) + verification : verification;
      data_.short_code = document["user_code"] | "";
      auth_interval_ = std::max(5u, document["interval"].as<unsigned>()) * 1000;
      auth_start_ = millis(); auth_lifetime_ = std::min(300u, document["expires_in"].as<unsigned>()) * 1000; auth_next_ = auth_start_ + auth_interval_;
      if (data_.ble_setup && !ble_setup_.set_code(data_.short_code, auth_start_, auth_lifetime_)) { device_code_.clear(); data_.error = "Authorization code unavailable. Try again."; break; }
      data_.status = data_.ble_setup ? "Continue on your phone\nCheck this code, then approve" : "Scan with your phone\nCheck this code, then approve"; break;
    }
    case Operation::PollAuthorization:
      ble_setup_.stop(); data_.ble_setup = false; ble_pending_ = ble_configured_ = false;
      session_.token = document["access_token"] | "";
      device_code_.clear(); auth_lifetime_ = 0; data_.qr.clear(); data_.short_code.clear();
      if (!session_.token.empty()) validate_session();
      else data_.error = "Authorization did not return a session";
      break;
    case Operation::Profile: {
      const std::string id = document["id"] | "";
      if (id.empty() || (!session_.user.empty() && session_.user != id)) { retire_session(false); return; }
      const bool first = checking_session_ || !state_.authenticated;
      if (first) {
        state_.sign_in(id); network_.retire(state_.owner().account); pending_.retire(); session_.user = id; storage_.save(session_);
        checking_session_ = false; refresh_dms();
        request(Operation::SocketStart, "", "", "", id);
      }
      data_.human_name = document["name"] | ""; data_.human_handle = data_.human_name + "#" + (document["discriminator"] | "0000");
      const std::string avatar = document["avatar"] | "";
      if (avatar != human_avatar_) {
        human_avatar_ = avatar; ui_.set_human_image(nullptr); human_image_.clear();
        data_.human_custom = !avatar.empty() && (avatar.front() == '/' || avatar.compare(0, 8, "https://") == 0);
        ui_.set_human_seed(avatar.compare(0, 12, "avatar:beam:") == 0 ? avatar.substr(12) : id);
        if (data_.human_custom) request(Operation::AvatarHuman, "GET", avatar, "", id);
      }
      if (!first) return;
      break;
    }
    case Operation::Dms: {
      std::vector<DmItem> next;
      if (!read_dms(document["conversations"], next)) { data_.dm_error = "Could not read DMs. Refresh to try again."; if (!background_dms) render(); return; }
      for (auto& dm : next) for (const auto& previous : data_.dms) if (dm.id == previous.id && dm.user_id == previous.user_id) {
        dm.human = previous.human; dm.identity_known = previous.identity_known; dm.online = previous.online;
      }
      data_.dms = std::move(next); data_.dms_loaded = true; data_.dm_error.clear();
      if (!state_.channel_id.empty()) {
        const auto selected = std::find_if(data_.dms.begin(), data_.dms.end(), [&](const auto& dm) { return dm.id == state_.channel_id && dm.user_id == state_.recipient_id; });
        if (selected == data_.dms.end()) { audio_.cancel(); clear_dm(); session_.channel.clear(); storage_.save(session_); enter(Page::DmList); return; }
        data_.dm_handle = selected->handle;
        if (state_.voice == VoicePhase::Empty) refresh_dm();
      } else if (!session_.channel.empty() && state_.page == Page::DmList) {
        const auto selected = std::find_if(data_.dms.begin(), data_.dms.end(), [&](const auto& dm) { return dm.id == session_.channel; });
        if (selected != data_.dms.end()) { select_dm(selected - data_.dms.begin()); return; }
        session_.channel.clear(); storage_.save(session_);
      }
      if (background_dms) return;
      break;
    }
    case Operation::Presence:
      read_presence(document.as<JsonVariantConst>(), data_.dms);
      for (const auto& dm : data_.dms) if (dm.id == state_.channel_id) data_.bot_online = online_ && dm.online;
      if (state_.page != Page::Character) return;
      break;
    case Operation::DmProfile: {
      if (document["id"] != state_.recipient_id || result.target != state_.recipient_id || (document["kind"] != "human" && document["kind"] != "bot")) { data_.error = "Recipient profile unavailable. Refresh DMs."; break; }
      for (auto& dm : data_.dms) if (dm.id == state_.channel_id && dm.user_id == state_.recipient_id) {
        const auto old_image = dm.image;
        dm.human = document["kind"] == "human"; dm.identity_known = true;
        dm.handle = std::string(document["name"] | "") + "#" + (document["discriminator"] | "0000");
        dm.image = document["image"] | "";
        if (dm.image != old_image && state_.page == Page::Character && state_.voice == VoicePhase::Empty) ui_.prepare_transition();
        data_.dm_human = dm.human; data_.dm_handle = dm.handle;
        const bool generated = dm.image.compare(0, 12, "avatar:beam:") == 0;
        data_.bot_custom = !dm.image.empty() && !generated && (dm.image.front() == '/' || dm.image.compare(0, 8, "https://") == 0);
        if (data_.bot_custom) {
          const bool cached = bot_image_.image() && cached_bot_recipient_ == dm.user_id && cached_bot_source_ == dm.image;
          ui_.set_character(cached ? bot_image_.image() : nullptr, cached ? bot_image_.texture() : nullptr);
          if (!cached) {
            bot_image_.clear(); cached_bot_recipient_.clear(); cached_bot_source_.clear();
            request(Operation::AvatarBot, "GET", dm.image, "", dm.user_id);
          }
        } else { ui_.set_character(nullptr); ui_.set_seed(generated ? dm.image.substr(12) : dm.user_id); }
      }
      break;
    }
    case Operation::OpenDm: {
      bool can_read = false, can_send = false;
      if (result.target != state_.channel_id || !read_dm_access(document.as<JsonVariantConst>(), state_.channel_id, can_read, can_send)) { clear_dm_access(); data_.error = "Unsupported DM response. Refresh to try again."; break; }
      data_.dm_can_read = can_read; data_.dm_can_send = can_send;
      if (!can_read) clear_dm_access();
      else if (data_.messages.empty()) request_history();
      break;
    }
    case Operation::History: {
      if (!data_.dm_can_read) return;
      const bool preserve = result.target != "tail";
      const bool previous_older = data_.has_older;
      std::vector<MessageItem> incoming;
      if (!read_dm_history(document.as<JsonVariantConst>(), state_.channel_id, state_.user_id, incoming)) { data_.error = "Unsupported chat response. Try again."; break; }
      const auto changed = merge_history(data_.messages, std::move(incoming), result.target);
      older_cursor_ = data_.messages.empty() ? "" : data_.messages.front().cursor;
      newer_cursor_ = data_.messages.empty() ? "" : data_.messages.back().cursor;
      data_.has_older = result.target == "after" ? previous_older || changed.dropped_older : (document["page"]["hasMoreOlder"] | false);
      if (changed.dropped_older) data_.has_older = true;
      data_.has_newer = (document["page"]["hasMoreNewer"] | false) || (!data_.messages.empty() && data_.messages.back().seq < (document["page"]["latestSeq"] | 0u));
      data_.new_messages = preserve && data_.has_newer;
      if (state_.page == Page::Conversation) { preserve_history_ = preserve; render(); }
      return;
    }
    case Operation::Transcribe: {
      const std::string text = document["text"] | "";
      if (!state_.transcript(result.owner, text.size() > 16000 ? "" : text)) data_.error = "No usable transcript. Record again.";
      break;
    }
    case Operation::Send: {
      const auto message = document["message"];
      const std::string nonce = message["clientNonce"] | "";
      if (document["channelId"] != state_.channel_id || message["channelId"] != state_.channel_id || message["authorId"] != state_.user_id || !state_.sent(result.owner, nonce)) {
        state_.failed_send(result.owner); data_.error = "Confirmation missing. Retry the same message.";
      } else request_history();
      break;
    }
    case Operation::Read:
      if (document["channelId"] == state_.channel_id) read_seq_ = std::max(read_seq_, std::min(requested_read_seq_, document["targetSeq"].as<uint32_t>()));
      return;
    case Operation::LookupPeer: {
      const auto users = document["users"].as<JsonArrayConst>();
      if (users.size() != 1 || users[0]["id"] == state_.user_id) { data_.error = "Nearby account unavailable"; break; }
      peer_id_ = users[0]["id"] | "";
      request(Operation::PeerProfile, "GET", "/api/community/users/" + encode(peer_id_) + "/profile", "", peer_code_);
      break;
    }
    case Operation::PeerProfile: {
      if (document["kind"] != "human" || document["id"] != peer_id_ || peer_id_ == state_.user_id) { peer_id_.clear(); data_.error = "Nearby account must be a human"; break; }
      const std::string name = document["name"] | "", discriminator = document["discriminator"] | "";
      if (name.empty() || name + "#" + discriminator != peer_code_) { peer_id_.clear(); data_.error = "Nearby identity changed. Try again."; break; }
      data_.peer_name = name; data_.peer_handle = peer_code_;
      const std::string avatar = document["image"] | "";
      if (avatar != peer_avatar_) {
        peer_avatar_ = avatar; ui_.set_peer_image(nullptr); peer_image_.clear();
        data_.peer_custom = !avatar.empty() && (avatar.front() == '/' || avatar.compare(0, 8, "https://") == 0);
        ui_.set_peer_seed(avatar.compare(0, 12, "avatar:beam:") == 0 ? avatar.substr(12) : peer_id_);
        if (data_.peer_custom) request(Operation::AvatarPeer, "GET", avatar, "", peer_code_);
      }
      request(Operation::FriendsPending, "GET", "/api/community/friends/pending", "", peer_code_);
      request(Operation::FriendsAccepted, "GET", "/api/community/friends/accepted", "", peer_code_);
      friendship_state();
      break;
    }
    case Operation::FriendsAccepted:
      if (document["stale"] == true || !document["friends"].is<JsonArray>()) { friends_known_ = false; friendship_state(); break; }
      friends_ = false; friends_known_ = true;
      for (const auto item : document["friends"].as<JsonArrayConst>()) if (item["userId"] == peer_id_) friends_ = true;
      friendship_state(); break;
    case Operation::FriendsPending:
      if (document["stale"] == true || !document["pending"].is<JsonArray>()) { pending_known_ = false; friendship_state(); break; }
      pending_known_ = true; pending_state_ = "none"; friendship_.clear();
      for (const auto item : document["pending"].as<JsonArrayConst>()) if (item["userId"] == peer_id_) {
        pending_state_ = !item["needsOwnerApproval"].isNull() ? "owner_approval" : item["kind"] | "none"; friendship_ = item["id"] | "";
      }
      friendship_state(); break;
    case Operation::Friend:
    case Operation::AcceptFriend:
      resolved_at_ = 0; data_.peer_state = "Checking friendship…"; break;
    default: return;
  }
  preserve_history_ = state_.page == Page::Conversation;
  render();
}

void Application::friendship_state() {
  data_.peer_state = !friends_known_ || !pending_known_ ? "Checking friendship…" : friends_ ? "friends" : pending_state_;
}

void Application::tick() {
  if (restart_at_ && static_cast<int32_t>(millis() - restart_at_) >= 0) esp_restart();
  if (portal_) provisioning_.process();
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != online_) {
    online_ = connected;
    if (online_) configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
    else { data_.bot_online = false; retire_presence(data_.dms); nearby_.stop(); broadcast_handle_.clear(); peer_code_.clear(); peer_id_.clear(); data_.peer_name.clear(); data_.peer_handle.clear(); data_.peer_state.clear(); data_.status = "Offline · reconnecting"; }
    if (state_.page == Page::Settings) data_.status = std::string("Wi-Fi: ") + (online_ ? "connected" : "offline");
    if (state_.page != Page::Startup) render();
  }
  if (portal_ && !provisioning_.getConfigPortalActive()) finish_network_setup();
  for (unsigned i = 0; i < 12; ++i) { auto result = network_.receive(); if (!result) break; response(std::move(*result)); }
  const auto now = millis();
  if (state_.page == Page::Startup && now - boot_ >= 1200) {
    state_.page = Page::Network; data_.status = "Connecting to saved Wi-Fi…"; render();
  }
  tick_network_setup(now);
  if (state_.page == Page::Network && !data_.ble_setup) {
    if (!portal_ && online_ && time(nullptr) > 1700000000) {
      data_.qr.clear(); data_.short_code.clear(); state_.page = Page::Authorization;
      if (session_.token.empty()) authorize(); else { data_.status = "Checking your session…"; validate_session(); render(); }
    } else if (!online_ && !portal_ && !network_attempted_ && now - boot_ >= 12000) start_network_setup();
  }
  if (state_.page == Page::Authorization && !device_code_.empty() && auth_lifetime_) {
    if (now - auth_start_ >= auth_lifetime_) { device_code_.clear(); ble_setup_.clear_code(); if (!data_.ble_setup) data_.qr.clear(); data_.short_code.clear(); data_.error = "Code expired. Get a new code."; render(); }
    else if (online_ && static_cast<int32_t>(now - auth_next_) >= 0) {
      JsonDocument body; body["client_id"] = client_id; body["device_code"] = device_code_; body["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code";
      if (request(Operation::PollAuthorization, "POST", "/api/auth/device/token", json(body))) auth_next_ = now + auth_interval_;
    }
  }
  if (state_.authenticated && online_ && !data_.ble_setup && !portal_ && now - validated_at_ >= 15000) validate_session();
  if (state_.authenticated && online_ && state_.page == Page::Profile && (!requests_at_ || now - requests_at_ >= 15000)) refresh_requests();
  if (state_.authenticated && online_ && state_.page == Page::Profile && !state_.profile_requests_only) {
    if (broadcast_handle_ != data_.human_handle || !nearby_.active()) {
      if (nearby_.start(data_.human_handle)) broadcast_handle_ = data_.human_handle;
      else { data_.error = "Nearby discovery unavailable"; render(); }
    }
    const auto peer = nearby_.peer();
    if (peer != peer_code_) {
      peer_code_ = peer; peer_id_.clear(); friendship_.clear(); data_.peer_name.clear(); data_.peer_handle.clear(); data_.peer_state.clear();
      friends_known_ = pending_known_ = friends_ = false; pending_state_.clear();
      ui_.set_peer_image(nullptr); peer_image_.clear(); peer_avatar_.clear();
      resolved_at_ = 0; render();
    }
    if (!peer_code_.empty() && (!resolved_at_ || now - resolved_at_ >= 5000)) {
      if (request(Operation::LookupPeer, "GET", "/api/community/users/search?q=" + encode(peer_code_), "", peer_code_)) resolved_at_ = now;
    }
  }
  if (state_.authenticated && online_ && state_.voice == VoicePhase::Empty && now - dms_at_ >= 15000) refresh_dms();
  if (state_.authenticated && online_ && state_.voice == VoicePhase::Empty && !state_.channel_id.empty() && now - metadata_at_ >= 15000) refresh_dm();
  if (state_.page == Page::Conversation && online_ && data_.dm_can_read) {
    if ((history_dirty_ && now - history_at_ >= 1000) || now - history_at_ >= 15000) {
      const auto anchor = ui_.reading_anchor();
      if (!ui_.reading_latest() && !anchor.empty()) request_history("around", anchor); else request_history();
    }
    if (!data_.has_newer && ui_.reading_latest() && !data_.messages.empty() && data_.messages.back().seq > read_seq_) {
      JsonDocument body; body["lastReadMessageId"] = data_.messages.back().id;
      if (request(Operation::Read, "PUT", "/api/community/channels/" + encode(state_.channel_id) + "/read", json(body))) requested_read_seq_ = data_.messages.back().seq;
    }
  }
  const auto buttons = board_buttons();
  if (buttons.record_pressed) recording_start();
  audio_.tick();
  if (buttons.record_released || audio_.full()) recording_finish();
  if (buttons.home && data_.update_phase != UpdatePhase::Installing && data_.update_phase != UpdatePhase::Restarting) {
    const bool was_profile = state_.page == Page::Profile;
    if ((state_.page == Page::Network && portal_) || data_.ble_setup) finish_network_setup();
    else if (state_.home()) {
      audio_.cancel();
      if (was_profile) leave_profile();
      data_.error.clear(); render();
    }
    else if (!state_.authenticated && state_.page == Page::Authorization) start_network_setup();
  }
  ui_.tick(now);
  if (const auto* frame = ui_.direct_frame()) board_present(frame);
}
}
