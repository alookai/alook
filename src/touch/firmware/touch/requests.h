#pragma once
#include <string>

namespace alook_touch {
struct FriendRequestItem { std::string id; std::string user_id; std::string name; std::string kind; bool needs_owner_approval = false; };
}
