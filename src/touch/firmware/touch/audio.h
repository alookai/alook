#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>

namespace alook_touch {
struct AudioClip {
  uint8_t* data = nullptr;
  size_t size = 0;
  ~AudioClip();
};
class AudioRecorder {
public:
  bool begin();
  bool start();
  void tick();
  bool full() const;
  std::shared_ptr<AudioClip> finish();
  void cancel();
private:
  bool ready_ = false;
  std::shared_ptr<AudioClip> clip_;
};
}
