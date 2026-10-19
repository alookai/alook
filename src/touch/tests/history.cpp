#include "../firmware/touch/history.h"
#include <cassert>
#include <iostream>

using namespace alook_touch;
static std::vector<MessageItem> page(int first, int last) {
  std::vector<MessageItem> result;
  for (int seq = first; seq <= last; ++seq) result.push_back({std::to_string(seq), "author", "text", false, static_cast<uint32_t>(seq), "time|" + std::to_string(seq)});
  return result;
}
int main() {
  auto messages = page(61, 80);
  merge_history(messages, page(41, 60), "before");
  assert(messages.size() == 40 && messages.front().seq == 41 && messages.back().seq == 80);
  merge_history(messages, page(21, 40), "before");
  const auto older = merge_history(messages, page(1, 20), "before");
  assert(older.dropped_newer && !older.dropped_older);
  assert(messages.size() == 60 && messages.front().seq == 1 && messages.back().seq == 60);
  const auto newer = merge_history(messages, page(61, 80), "after");
  assert(newer.dropped_older && !newer.dropped_newer);
  assert(messages.size() == 60 && messages.front().seq == 21 && messages.back().seq == 80);
  auto overlap = page(71, 90);
  overlap[0].text = "updated";
  merge_history(messages, overlap, "after");
  assert(messages.size() == 60 && messages.front().seq == 31 && messages.back().seq == 90);
  assert(messages[40].seq == 71 && messages[40].text == "updated");
  merge_history(messages, {}, "before");
  assert(messages.size() == 60);
  merge_history(messages, page(101, 120), "tail");
  assert(messages.size() == 20 && messages.front().seq == 101 && messages.back().seq == 120);
  std::cout << "Continuous bounded history windows passed\n";
}
