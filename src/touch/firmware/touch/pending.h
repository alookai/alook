#pragma once
#include "ownership.h"
#include <array>
#include <string>

namespace alook_touch {
template<size_t Count> class PendingRequests {
public:
  uint32_t start(size_t operation, Owner owner, const std::string& target) {
    auto& slot = slots_[operation];
    if (slot.id && slot.owner.account == owner.account && slot.owner.recipient == owner.recipient && slot.owner.profile == owner.profile && slot.target == target) return 0;
    if (++sequence_ == 0) ++sequence_;
    slot = {sequence_, owner, target};
    return sequence_;
  }
  bool complete(size_t operation, uint32_t id) {
    auto& slot = slots_[operation];
    if (id == 0 || slot.id != id) return false;
    slot = {};
    return true;
  }
  void retire() { slots_.fill({}); }
private:
  struct Slot { uint32_t id = 0; Owner owner{}; std::string target; };
  std::array<Slot, Count> slots_{};
  uint32_t sequence_ = 0;
};
}
