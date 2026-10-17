#pragma once
#include "avatar_identity.h"
#include <lvgl.h>

namespace alook_touch {
class FeatureArt {
public:
  ~FeatureArt();
  bool load(const lv_img_dsc_t* source);
  bool make_halo();
  const lv_img_dsc_t* image() const { return &image_; }
private:
  uint8_t* pixels_ = nullptr;
  lv_img_dsc_t image_{};
};

class AvatarArt {
public:
  ~AvatarArt();
  bool set_seed(const std::string& seed, bool include_face = false);
  const lv_img_dsc_t* image() const { return &image_; }
  AvatarIdentity identity{};
private:
  uint8_t* pixels_ = nullptr;
  lv_img_dsc_t image_{};
};
}
