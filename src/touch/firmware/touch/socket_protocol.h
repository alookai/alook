#pragma once
#include <ArduinoJson.h>

namespace alook_touch {
inline constexpr unsigned socket_contract = 1;
inline bool socket_auth_ok(JsonVariantConst event) {
  if (!event.is<JsonObjectConst>() || event["type"] != "auth.ok") return false;
  auto contract = event["communityContract"];
  return contract.isUnbound() || (contract.is<unsigned>() && contract.as<unsigned>() == socket_contract);
}
}
