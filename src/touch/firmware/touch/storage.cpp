#include "storage.h"
#include <ArduinoJson.h>

namespace alook_touch {
bool Storage::begin() { return preferences_.begin("alook-touch", false); }
SavedSession Storage::read() {
  const auto text = preferences_.getString("session", "");
  JsonDocument document;
  if (text.length() > 4096 || deserializeJson(document, text)) return {};
  return {document["token"] | "", document["user"] | "", document["channel"] | ""};
}
bool Storage::save(const SavedSession& session) {
  JsonDocument document;
  document["token"] = session.token;
  document["user"] = session.user;
  document["channel"] = session.channel;
  String text;
  serializeJson(document, text);
  return preferences_.putString("session", text) == text.length();
}
void Storage::clear() { preferences_.remove("session"); }
uint8_t Storage::brightness() { return preferences_.getUChar("brightness", 180); }
void Storage::brightness(uint8_t value) { preferences_.putUChar("brightness", value); }
}
