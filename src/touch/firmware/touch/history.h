#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>
#include <utility>

namespace alook_touch {
struct MessageItem {
  std::string id;
  std::string author;
  std::string text;
  bool own = false;
  uint32_t seq = 0;
  std::string cursor;
};
struct WindowChange { bool dropped_older = false; bool dropped_newer = false; };

inline WindowChange merge_history(std::vector<MessageItem>& current, std::vector<MessageItem> incoming, const std::string& direction, size_t limit = 60) {
  WindowChange result;
  const bool adjacent = direction == "before" || direction == "after";
  if (adjacent) for (const auto& previous : current) {
    if (std::none_of(incoming.begin(), incoming.end(), [&](const auto& item) { return item.id == previous.id; })) incoming.push_back(previous);
  }
  std::stable_sort(incoming.begin(), incoming.end(), [](const auto& left, const auto& right) { return left.seq < right.seq; });
  if (incoming.size() > limit) {
    if (direction == "before") { incoming.resize(limit); result.dropped_newer = true; }
    else { incoming.erase(incoming.begin(), incoming.end() - limit); result.dropped_older = true; }
  }
  current = std::move(incoming);
  return result;
}
}
