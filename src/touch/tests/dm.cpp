#include "../firmware/touch/dm_protocol.h"
#include "../firmware/touch/ownership.h"
#include <cassert>
#include <iostream>
using namespace alook_touch;
int main() {
  JsonDocument payload;
  assert(!deserializeJson(payload, R"({"conversations":[{"id":"old","userId":"human","name":"真人","discriminator":"0001","avatar":"avatar:beam:human","activityAt":"2026-10-01T00:00:00Z","unread":false,"status":"online","preview":"not a canonical preview"},{"id":"new","userId":"bot","name":"Samara","discriminator":"8738","activityAt":"2026-10-02T00:00:00Z","unread":true}]})"));
  std::vector<DmItem> dms;
  assert(read_dms(payload["conversations"], dms));
  assert(dms.size() == 2 && dms[0].id == "new" && dms[0].unread);
  assert(dms[1].handle == "真人#0001" && !dms[1].online && !dms[1].identity_known && dms[1].preview.empty());
  JsonDocument presence;
  deserializeJson(presence, R"({"online":["human"]})");
  assert(read_presence(presence.as<JsonVariantConst>(), dms) && dms[1].online);
  retire_presence(dms);
  assert(!dms[0].online && !dms[1].online);
  deserializeJson(presence, R"({"online":[]})");
  assert(read_presence(presence.as<JsonVariantConst>(), dms) && !dms[1].online);
  dms[1].online = true;
  deserializeJson(presence, R"({"online":["human"],"stale":true})");
  assert(!read_presence(presence.as<JsonVariantConst>(), dms) && !dms[1].online);
  payload["conversations"][0]["activityAt"] = "2026-10-02T00:00:00Z";
  assert(read_dms(payload["conversations"], dms) && dms[0].id == "old");
  payload["conversations"][0]["id"] = "new";
  assert(!read_dms(payload["conversations"], dms) && dms.size() == 2);
  payload["conversations"] = nullptr;
  assert(!read_dms(payload["conversations"], dms) && dms.size() == 2);
  payload["conversations"].to<JsonArray>();
  assert(read_dms(payload["conversations"], dms) && dms.empty());
  assert(!deserializeJson(payload, R"({"contractVersion":3,"channelId":"A","channel":{"id":"A","type":"dm"},"access":{"channelId":"A","canRead":true,"canSend":false}})"));
  bool read = false, send = true;
  assert(read_dm_access(payload.as<JsonVariantConst>(), "A", read, send) && read && !send);
  assert(!read_dm_access(payload.as<JsonVariantConst>(), "B", read, send));
  payload["access"]["canRead"] = false; payload["access"]["canSend"] = true;
  assert(read_dm_access(payload.as<JsonVariantConst>(), "A", read, send) && !read && !send);
  payload["channel"]["type"] = "text";
  assert(!read_dm_access(payload.as<JsonVariantConst>(), "A", read, send));
  JsonDocument history;
  deserializeJson(history, R"({"contractVersion":3,"channelId":"A","page":{"hasMoreOlder":true,"hasMoreNewer":false,"latestSeq":2},"messages":[{"id":"m2","channelId":"A","authorId":"human","authorName":"真人","content":"完整消息","createdAt":"2026-10-01T00:00:00Z","seq":2,"attachments":[]}]})");
  std::vector<MessageItem> messages;
  assert(read_dm_history(history.as<JsonVariantConst>(), "A", "human", messages) && messages[0].own && messages[0].text == "完整消息");
  assert(!read_dm_history(history.as<JsonVariantConst>(), "B", "human", messages) && messages.size() == 1);
  history["messages"] = nullptr;
  assert(!read_dm_history(history.as<JsonVariantConst>(), "A", "human", messages) && messages.size() == 1);
  history["messages"].to<JsonArray>();
  assert(read_dm_history(history.as<JsonVariantConst>(), "A", "human", messages) && messages.empty());
  Interaction app; app.sign_in("owner");
  assert(app.page == Page::DmList && app.select_recipient("human", "A"));
  const auto a = app.owner();
  assert(app.select_recipient("bot", "B") && !app.accepts_recipient(a));
  assert(app.select_recipient("human", "A") && !app.accepts_recipient(a));
  const auto current = app.owner();
  assert(app.select_recipient("human", "A") && app.accepts_recipient(current));
  assert(app.start_recording()); const auto voice = app.owner();
  app.invalidate_recipient();
  assert(!app.accepts_recipient(voice) && app.voice == VoicePhase::Empty && app.channel_id == "A");
  app.invalidate_recipient(true);
  assert(app.channel_id.empty() && app.recipient_id.empty());
  app.sign_out(); app.sign_in("replacement"); app.select_recipient("human", "A");
  assert(!app.accepts_account(current));
  std::cout << "touch existing DM contracts and ownership passed\n";
}
