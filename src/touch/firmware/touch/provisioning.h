#pragma once
#include "provisioning_grant.h"
#include <network_provisioning/manager.h>
#include <atomic>
#include <string>

namespace alook_touch {
inline constexpr const char* provision_service_uuid = "b4df5a1c-3f6b-f4bf-ea4a-820304901a02";
class Provisioning {
public:
  bool start(const std::string& name);
  void stop();
  void tick(uint32_t now);
  bool active() const { return initialized_; }
  bool take_configured() { return configured_.exchange(false); }
  bool take_failure();
  const std::string& qr() const { return qr_; }
  void clear_code() { grant_.clear(); }
  bool set_code(const std::string& code, uint32_t now, uint32_t lifetime) { return grant_.set(code, now, lifetime); }
private:
  bool initialized_ = false;
  uint32_t started_ = 0;
  std::string pop_, qr_;
  ProvisioningGrant grant_;
  std::atomic<bool> configured_{false}, failed_{false}, ended_{false}, stopping_{false};
  static void event(void* context, network_prov_cb_event_t event, void* data);
  static esp_err_t endpoint(uint32_t session, const uint8_t* input, ssize_t size, uint8_t** output, ssize_t* output_size, void* context);
};
}
