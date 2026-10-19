#pragma once
#include "dm.h"
#include "history.h"
#include <ArduinoJson.h>
namespace alook_touch {
inline bool read_dms(JsonVariantConst value, std::vector<DmItem>& result) {
  if (!value.is<JsonArrayConst>() || value.size() > 1024) return false;
  std::vector<DmItem> next;
  for (const auto row : value.as<JsonArrayConst>()) {
    if (!row["id"].is<const char*>() || !row["userId"].is<const char*>() || !row["name"].is<const char*>() || !row["discriminator"].is<const char*>() || !row["activityAt"].is<const char*>() || !row["unread"].is<bool>()) return false;
    DmItem item;
    item.id = row["id"].as<std::string>(); item.user_id = row["userId"].as<std::string>();
    if (item.id.empty() || item.user_id.empty() || std::any_of(next.begin(), next.end(), [&](const auto& other) { return other.id == item.id; })) return false;
    item.handle = row["name"].as<std::string>() + "#" + row["discriminator"].as<std::string>();
    item.image = row["avatar"] | ""; item.activity = row["activityAt"].as<std::string>(); item.unread = row["unread"].as<bool>();
    next.push_back(std::move(item));
  }
  std::sort(next.begin(), next.end(), [](const auto& a, const auto& b) { return a.activity != b.activity ? a.activity > b.activity : a.id > b.id; });
  result = std::move(next);
  return true;
}
inline bool read_dm_access(JsonVariantConst value, const std::string& channel, bool& can_read, bool& can_send) {
  if (value["contractVersion"] != 3 || value["channelId"] != channel || value["channel"]["id"] != channel || value["channel"]["type"] != "dm" || value["access"]["channelId"] != channel || !value["access"]["canRead"].is<bool>() || !value["access"]["canSend"].is<bool>()) return false;
  can_read = value["access"]["canRead"].as<bool>(); can_send = can_read && value["access"]["canSend"].as<bool>();
  return true;
}
inline bool read_presence(JsonVariantConst value, std::vector<DmItem>& dms) {
  retire_presence(dms);
  if (value["stale"] == true || !value["online"].is<JsonArrayConst>()) return false;
  for (const auto id : value["online"].as<JsonArrayConst>()) if (!id.is<const char*>()) return false;
  for (auto& dm : dms) for (const auto id : value["online"].as<JsonArrayConst>()) if (id == dm.user_id) dm.online = true;
  return true;
}

inline bool read_dm_history(JsonVariantConst value, const std::string& channel, const std::string& viewer, std::vector<MessageItem>& messages) {
  if (value["contractVersion"] != 3 || value["channelId"] != channel || !value["messages"].is<JsonArrayConst>() || !value["page"]["hasMoreOlder"].is<bool>() || !value["page"]["hasMoreNewer"].is<bool>() || !value["page"]["latestSeq"].is<uint32_t>()) return false;
  std::vector<MessageItem> next;
  for (const auto row : value["messages"].as<JsonArrayConst>()) {
    if (row["channelId"] != channel || !row["id"].is<const char*>() || !row["authorId"].is<const char*>() || !row["content"].is<const char*>() || !row["createdAt"].is<const char*>() || !row["seq"].is<uint32_t>() || !row["attachments"].is<JsonArrayConst>()) return false;
    const std::string id = row["id"].as<std::string>(), created = row["createdAt"].as<std::string>();
    if (id.empty() || created.empty() || std::any_of(next.begin(), next.end(), [&](const auto& previous) { return previous.id == id || previous.seq == row["seq"].as<uint32_t>(); })) return false;
    std::string text = row["content"].as<std::string>();
    for (const auto attachment : row["attachments"].as<JsonArrayConst>()) text += "\n[Attachment: " + std::string(attachment["name"] | "file") + "]";
    if (text.empty()) text = row["approval"].is<JsonObjectConst>() ? "[Friend request]" : "[Message]";
    next.push_back({id, row["authorName"] | row["authorId"].as<const char*>(), text, row["authorId"] == viewer, row["seq"].as<uint32_t>(), created + "|" + id});
  }
  messages = std::move(next);
  return true;
}

}
