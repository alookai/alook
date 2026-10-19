#pragma once
#include "avatar_identity.h"
#include <lvgl.h>

namespace alook_touch {
class FeatureArt {
public:
  ~FeatureArt();
  bool load(const lv_img_dsc_t* source);
  bool make_halo();
  void swap(FeatureArt& other);
  void reset_projection();
  int projected_x() const { return projected_left_; }
  const lv_img_dsc_t* project(float look_x, int origin_x, int origin_y, bool& changed);
  const lv_img_dsc_t* image() const { return &image_; }
private:
  uint8_t* pixels_ = nullptr;
  lv_img_dsc_t image_{};
  uint8_t* projected_pixels_ = nullptr;
  lv_img_dsc_t projected_{};
  float* depths_ = nullptr;
  int projected_angle_ = -1000, origin_x_ = -1, origin_y_ = -1, projected_left_ = 0;
};

class AvatarArt {
public:
  ~AvatarArt();
  bool set_seed(const std::string& seed, bool include_face = false);
  void swap(AvatarArt& other);
  const lv_img_dsc_t* image() const { return &image_; }
  AvatarIdentity identity{};
private:
  uint8_t* pixels_ = nullptr;
  lv_img_dsc_t image_{};
  size_t capacity_ = 0;
};
}
