#include "../firmware/touch/proximity.h"
#include <cassert>
#include <iostream>

int main() {
  alook_touch::Proximity nearby;
  const std::string first(22, 'a'), second(22, 'b');
  nearby.observe(first, -50, 100); nearby.observe(first, -50, 250);
  assert(nearby.peer(250).empty());
  nearby.observe(first, -50, 400); assert(nearby.peer(400) == first);
  assert(nearby.peer(3000).empty());
  for (unsigned i = 0; i < 20; ++i) nearby.observe(second, -90, 4000 + i * 100);
  assert(nearby.peer(6000).empty());
  nearby.observe(first, -40, 6100); nearby.observe(first, -40, 6200); nearby.observe(first, -40, 6300);
  assert(nearby.peer(6300) == first);
  nearby.reset(); assert(nearby.peer(6301).empty());
  std::cout << "Nearby presence qualification passed\n";
}
