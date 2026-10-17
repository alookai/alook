#pragma once
#include <lvgl.h>
#include <string>

namespace alook_touch {
class ImageArt {
public:
  ~ImageArt();
  bool decode(const std::string& bytes);
  void clear();
  const lv_img_dsc_t* image() const { return pixels_ ? &image_ : nullptr; }
private:
  uint8_t* pixels_ = nullptr;
  lv_img_dsc_t image_{};
};
}
