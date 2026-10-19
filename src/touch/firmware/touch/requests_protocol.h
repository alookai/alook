#pragma once
#include "requests.h"
#include <ArduinoJson.h>
#include <set>
#include <string>
#include <vector>

namespace alook_touch {

inline bool read_requests(JsonVariantConst document, std::vector<FriendRequestItem>& out) {
  if (!document.is<JsonObjectConst>() || document["stale"] == true || !document["pending"].is<JsonArrayConst>() || document["pending"].size() > 1024) return false;
  std::vector<FriendRequestItem> rows;
  std::set<std::string> ids;
  for (const auto item : document["pending"].as<JsonArrayConst>()) {
    if (!item["id"].is<const char*>() || !item["userId"].is<const char*>() || !item["name"].is<const char*>() || !item["kind"].is<const char*>() || item["needsOwnerApproval"].as<JsonVariantConst>().isUnbound()) return false;
    FriendRequestItem row{item["id"].as<std::string>(), item["userId"].as<std::string>(), item["name"].as<std::string>(), item["kind"].as<std::string>(), !item["needsOwnerApproval"].isNull()};
    if (row.id.empty() || row.user_id.empty() || row.name.empty() || !ids.insert(row.id).second || (row.kind != "incoming" && row.kind != "outgoing") || (row.needs_owner_approval && !item["needsOwnerApproval"].is<const char*>())) return false;
    if (row.kind == "incoming") rows.push_back(std::move(row));
  }
  out = std::move(rows);
  return true;
}

inline bool accepted_request(JsonVariantConst document, const std::string& id, const std::string& actor) {
  return document["id"] == id && document["status"] == "accepted" && document["addresseeId"] == actor;
}
}
