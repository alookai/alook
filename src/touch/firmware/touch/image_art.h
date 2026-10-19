#pragma once
#include <lvgl.h>
#include <memory>
#include <string>

namespace alook_touch {
struct DecodedImage {
  ~DecodedImage();
  lv_img_dsc_t image{};
  uint8_t* pixels = nullptr;
  const uint8_t* texture = nullptr;
};
std::shared_ptr<DecodedImage> decode_image(const std::string& bytes, bool turn = false);
class ImageArt {
public:
  ~ImageArt();
  bool decode(const std::string& bytes);
  void set(std::shared_ptr<DecodedImage> asset);
  void clear();
  const uint8_t* texture() const { return asset_ ? asset_->texture : nullptr; }
  const lv_img_dsc_t* image() const { return asset_ ? &asset_->image : nullptr; }
private:
  std::shared_ptr<DecodedImage> asset_;
};
}
