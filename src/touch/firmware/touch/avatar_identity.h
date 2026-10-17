#pragma once
#include "generated/avatar_palettes.h"
#include <string>
#include <cstdint>

namespace alook_touch {
inline uint32_t avatar_hash(const std::string& seed) {
  uint32_t hash = 0;
  auto add = [&](uint32_t unit) { hash = hash * 31u + unit; };
  for (size_t i = 0; i < seed.size();) {
    const auto first = static_cast<uint8_t>(seed[i++]);
    uint32_t code = first;
    unsigned tail = 0;
    if (first >= 0xf0) { code = first & 7; tail = 3; }
    else if (first >= 0xe0) { code = first & 15; tail = 2; }
    else if (first >= 0xc0) { code = first & 31; tail = 1; }
    bool valid = first < 0x80 || (first >= 0xc2 && first <= 0xf4);
    while (tail--) {
      if (i >= seed.size() || (static_cast<uint8_t>(seed[i]) & 0xc0) != 0x80) { valid = false; break; }
      code = (code << 6) | (static_cast<uint8_t>(seed[i++]) & 63);
    }
    if (!valid || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    if (code <= 0xffff) add(code);
    else { code -= 0x10000; add(0xd800 + (code >> 10)); add(0xdc00 + (code & 1023)); }
  }
  return hash & 0x80000000u ? 0u - hash : hash;
}

struct AvatarIdentity {
  uint32_t color;
  uint32_t hash;
  int eyes;
  int mouth;
  bool white;
};

inline AvatarIdentity avatar_identity(const std::string& seed) {
  const uint32_t hash = avatar_hash(seed), state = hash + 0x6d2b79f5u;
  uint32_t value = (state ^ (state >> 15)) * (1u | state);
  value = (value + (value ^ (value >> 7)) * (61u | value)) ^ value;
  const uint32_t random = value ^ (value >> 14);
  const size_t palette = (static_cast<uint64_t>(random) * 25) >> 32;
  const uint32_t color = avatar_palettes[palette][hash % 5];
  const bool white = ((color >> 16) * 299 + ((color >> 8) & 255) * 587 + (color & 255) * 114) < 128000;
  return {color, hash, static_cast<int>(((hash / 11) % 21) * 4 + (hash % 2) * 2 + white),
    static_cast<int>(((hash / 231) % 22) * 4 + (hash % 2) * 2 + white), white};
}
}
