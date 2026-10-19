#include "../firmware/touch/socket_protocol.h"
#include <cassert>
#include <iostream>
using namespace alook_touch;
int main() {
  static_assert(socket_contract == 1);
  for (const auto* json : {R"({"type":"auth.ok"})", R"({"type":"auth.ok","communityContract":1})"}) {
    JsonDocument document;
    assert(!deserializeJson(document, json));
    assert(socket_auth_ok(document.as<JsonVariantConst>()));
  }
  for (const auto* json : {"null", "[]", "{}", R"({"type":"auth.error"})", R"({"type":"auth.ok","communityContract":2})", R"({"type":"auth.ok","communityContract":3})", R"({"type":"auth.ok","communityContract":"1"})", R"({"type":"auth.ok","communityContract":null})"}) {
    JsonDocument document;
    assert(!deserializeJson(document, json));
    assert(!socket_auth_ok(document.as<JsonVariantConst>()));
  }
  std::cout << "socket auth protocol PASS\n";
}
