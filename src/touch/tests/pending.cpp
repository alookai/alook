#include "../firmware/touch/pending.h"
#include <cassert>
#include <iostream>

int main() {
  using namespace alook_touch;
  Interaction state;
  PendingRequests<4> requests;
  state.sign_in("human"); state.select_recipient("A");
  const auto a = requests.start(0, state.owner(), "A");
  assert(a && requests.start(0, state.owner(), "A") == 0);
  state.select_recipient("B"); state.enter(Page::Conversation);
  const auto b = requests.start(0, state.owner(), "B");
  assert(b && a != b);
  assert(!requests.complete(0, a));
  assert(requests.start(0, state.owner(), "B") == 0);
  assert(requests.complete(0, b));
  assert(!requests.complete(0, a));
  const auto old_profile = requests.start(1, state.owner(), "peer-old");
  const auto new_profile = requests.start(1, state.owner(), "peer-new");
  assert(!requests.complete(1, old_profile)); assert(requests.complete(1, new_profile));
  const auto retired = requests.start(2, state.owner(), "read");
  requests.retire(); assert(!requests.complete(2, retired));
  std::cout << "Pending ownership and late completion passed\n";
}
