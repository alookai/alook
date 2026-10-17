#pragma once
#include <algorithm>
#include <string>
#include <vector>

namespace alook_touch {
struct DmItem {
  std::string id;
  std::string user_id;
  std::string handle;
  std::string preview;
  bool human = false;
  bool online = false;
  bool unread = false;
  std::string image;
  std::string activity;
  bool identity_known = false;
};
inline void retire_presence(std::vector<DmItem>& dms) { for (auto& dm : dms) dm.online = false; }
}
