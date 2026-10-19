#include "provisioning.h"
#include <Arduino.h>
#include <BLEUUID.h>
#include <WiFi.h>
#include <network_provisioning/scheme_ble.h>
#include <esp_log.h>
#include <esp_random.h>
#include <cstdlib>
#include <cstring>

namespace alook_touch {
bool Provisioning::start(const std::string& name) {
  stop();
  if (name.size() != 18 || name.compare(0, 12, "ALOOK_TOUCH_") != 0) return false;
  for (size_t i = 12; i < name.size(); ++i) if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'A' && name[i] <= 'F'))) return false;
  for (const char* tag : {"network_prov_mgr", "network_prov_handlers", "network_prov_config_handlers", "network_prov_scan_handlers", "network_prov_scheme_ble", "protocomm_security1", "protocomm_ble", "wifi"}) esp_log_level_set(tag, ESP_LOG_NONE);
  if (!WiFi.STA.begin(false)) return false;
  network_prov_mgr_config_t configuration{};
  configuration.scheme = network_prov_scheme_ble;
  const network_prov_event_handler_t handler = NETWORK_PROV_EVENT_HANDLER_NONE;
  configuration.scheme_event_handler = handler;
  configuration.app_event_handler = {event, this};
  if (network_prov_mgr_init(configuration) != ESP_OK) return false;
  initialized_ = true;
  configured_.store(false); failed_.store(false); ended_.store(false); stopping_.store(false);
  uint8_t random[16]; esp_fill_random(random, sizeof(random));
  constexpr char hex[] = "0123456789abcdef";
  pop_.clear(); pop_.reserve(32);
  for (auto value : random) { pop_ += hex[value >> 4]; pop_ += hex[value & 15]; }
  BLEUUID service{String(provision_service_uuid)};
#if defined(CONFIG_NIMBLE_ENABLED)
  const auto* uuid = service.getNative()->u128.value;
#else
  const auto* uuid = service.getNative()->uuid.uuid128;
#endif
  if (network_prov_scheme_ble_set_service_uuid(const_cast<uint8_t*>(uuid)) != ESP_OK
      || network_prov_mgr_disable_auto_stop(1000) != ESP_OK
      || network_prov_mgr_endpoint_create("alook-auth") != ESP_OK
      || network_prov_mgr_start_provisioning(NETWORK_PROV_SECURITY_1, pop_.c_str(), name.c_str(), nullptr) != ESP_OK
      || network_prov_mgr_endpoint_register("alook-auth", endpoint, this) != ESP_OK) {
    stop(); return false;
  }
  JsonDocument code;
  code["ver"] = "v1"; code["name"] = name; code["pop"] = pop_; code["transport"] = "ble";
  code["security"] = 1; code["service_uuid"] = provision_service_uuid;
  serializeJson(code, qr_); started_ = millis();
  return true;
}
void Provisioning::stop() {
  if (initialized_) { network_prov_mgr_deinit(); initialized_ = false; }
  pop_.clear(); qr_.clear(); grant_.clear(); configured_.store(false); failed_.store(false); ended_.store(false); stopping_.store(false);
}
void Provisioning::tick(uint32_t now) {
  if (!initialized_) return;
  if (ended_.load()) { stop(); return; }
  if (now - started_ >= 300000 && !stopping_.exchange(true)) network_prov_mgr_stop_provisioning();
}
bool Provisioning::take_failure() {
  if (!failed_.exchange(false)) return false;
  if (initialized_) network_prov_mgr_reset_wifi_sm_state_on_failure();
  return true;
}
void Provisioning::event(void* context, network_prov_cb_event_t event, void*) {
  auto& setup = *static_cast<Provisioning*>(context);
  if (event == NETWORK_PROV_WIFI_CRED_SUCCESS) setup.configured_.store(true);
  else if (event == NETWORK_PROV_WIFI_CRED_FAIL) setup.failed_.store(true);
  else if (event == NETWORK_PROV_END) setup.ended_.store(true);
}
esp_err_t Provisioning::endpoint(uint32_t, const uint8_t* input, ssize_t size, uint8_t** output, ssize_t* output_size, void* context) {
  if (size < 0 || !output || !output_size) return ESP_ERR_INVALID_ARG;
  *output = nullptr; *output_size = 0;
  std::string response;
  auto& setup = *static_cast<Provisioning*>(context);
  if (!setup.grant_.exchange(input, static_cast<size_t>(size), millis(), response)) return ESP_ERR_INVALID_ARG;
  auto* result = static_cast<uint8_t*>(malloc(response.size()));
  if (!result) return ESP_ERR_NO_MEM;
  memcpy(result, response.data(), response.size());
  *output = result; *output_size = static_cast<ssize_t>(response.size());
  if (setup.grant_.acknowledged() && !setup.stopping_.exchange(true)) network_prov_mgr_stop_provisioning();
  return ESP_OK;
}
}
