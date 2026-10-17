#include "../firmware/touch/avatar_identity.h"
#include <cassert>
#include <iostream>

int main() {
  using namespace alook_touch;
  assert(avatar_hash("") == 0);
  assert(avatar_hash("Samara") == 1825822159);
  const auto identity = avatar_identity("Samara");
  assert(identity.color == 0xf0efc0);
  assert(!identity.white);
  for (const auto* seed : {"", "你好", "🫶", "touch-42"}) {
    const auto result = avatar_identity(seed);
    assert(result.eyes >= 0 && result.eyes < 84);
    assert(result.mouth >= 0 && result.mouth < 88);
  }
  std::cout << "Alook identity mapping passed\n";
}
