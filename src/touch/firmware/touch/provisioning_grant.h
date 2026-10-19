#pragma once
#include <ArduinoJson.h>
#include <cstdint>
#include <mutex>
#include <string>

namespace alook_touch {
class ProvisioningGrant {
public:
  static bool valid_code(const std::string& code) {
    const bool separated = code.size() == 9 && code[4] == '-';
    if (code.size() != 8 && !separated) return false;
    for (size_t i = 0; i < code.size(); ++i) if (!(separated && i == 4) && !((code[i] >= 'A' && code[i] <= 'Z') || (code[i] >= '0' && code[i] <= '9'))) return false;
    return true;
  }
  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    code_.clear(); expires_ = 0; acknowledged_ = false;
  }
  bool set(const std::string& code, uint32_t now, uint32_t lifetime) {
    if (!valid_code(code) || !lifetime || lifetime > 300000) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    code_ = code; expires_ = now + lifetime; acknowledged_ = false;
    return true;
  }
  bool exchange(const uint8_t* input, size_t size, uint32_t now, std::string& output) {
    if (!input || !size || size > 96) return false;
    JsonDocument request;
    if (deserializeJson(request, input, size) || !request.is<JsonObject>()) return false;
    const std::string action = request["action"] | "";
    const bool ack = action == "ack";
    if ((!ack && action != "code") || request.size() != (ack ? 2u : 1u)) return false;
    const std::string expected = request["user_code"] | "";
    if (ack && !valid_code(expected)) return false;
    JsonDocument response;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const bool live = !code_.empty() && static_cast<int32_t>(now - expires_) < 0;
      if (ack && (!live || expected != code_)) return false;
      if (live) {
        response["state"] = "ready"; response["user_code"] = code_;
        if (ack) acknowledged_ = true;
      } else response["state"] = "pending";
    }
    output.clear(); serializeJson(response, output);
    return true;
  }
  bool acknowledged() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return acknowledged_;
  }
private:
  mutable std::mutex mutex_;
  std::string code_;
  uint32_t expires_ = 0;
  bool acknowledged_ = false;
};
}
