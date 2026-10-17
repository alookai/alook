#pragma once
#include <Preferences.h>
#include <string>

namespace alook_touch {
struct SavedSession { std::string token; std::string user; std::string channel; };
class Storage {
public:
  bool begin();
  SavedSession read();
  bool save(const SavedSession& session);
  void clear();
  uint8_t brightness();
  void brightness(uint8_t value);
private:
  Preferences preferences_;
};
}
