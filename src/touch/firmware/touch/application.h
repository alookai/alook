#pragma once
#include "alook_network.h"
#include "audio.h"
#include "nearby.h"
#include "storage.h"
#include "ui.h"
#include "pending.h"
#include "image_art.h"
#include <WiFiManager.h>
#include <array>

namespace alook_touch {
class Application {
public:
  bool begin();
  void tick();
private:
  Interaction state_;
  UiData data_;
  Ui ui_;
  Storage storage_;
  Network network_;
  AudioRecorder audio_;
  Nearby nearby_;
  ImageArt bot_image_, human_image_, peer_image_;
  WiFiManager provisioning_;
  SavedSession session_;
  PsramJsonAllocator json_allocator_;
  PendingRequests<static_cast<size_t>(Operation::SocketClosed) + 1> pending_;
  std::string device_name_, hotspot_, hotspot_password_, device_code_;
  std::string older_cursor_, newer_cursor_, peer_code_, peer_id_, friendship_;
  std::string human_avatar_, peer_avatar_, broadcast_handle_;
  std::string update_manifest_, update_tag_;
  uint32_t boot_ = 0, auth_start_ = 0, auth_lifetime_ = 0, auth_next_ = 0, auth_interval_ = 5000;
  uint32_t dms_at_ = 0, metadata_at_ = 0, requests_at_ = 0;
  uint32_t validated_at_ = 0, history_at_ = 0, resolved_at_ = 0;
  uint32_t read_seq_ = 0, requested_read_seq_ = 0;
  uint32_t restart_at_ = 0;
  bool friends_known_ = false, pending_known_ = false, friends_ = false;
  std::string pending_state_;
  bool online_ = false, portal_ = false, checking_session_ = false, history_dirty_ = false, preserve_history_ = false;
  void render();
  void action(Action action, int argument);
  void authorize();
  void start_network_setup();
  void validate_session();
  void retire_session(bool revoke);
  void select_dm(size_t index);
  void refresh_dms();
  void refresh_dm();
  void refresh_requests();
  void clear_dm();
  void request_history(const std::string& window = "tail", const std::string& cursor = "");
  void recording_start();
  void recording_finish();
  void send();
  void leave_profile();
  void enter(Page page);
  void friendship_state();
  void response(Response result);
  bool request(Operation operation, const std::string& method, const std::string& path, const std::string& body = "", const std::string& target = "", std::shared_ptr<AudioClip> audio = nullptr);
};
}
