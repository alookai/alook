/* SPDX-License-Identifier: MIT
Adapted from Speaker irGenFrame/animIdleRainbow/avProject; see third_party/NOTICE.md. */
#pragma once
#include "avatar_identity.h"
#include "speaker_motion.h"
#include <lvgl.h>

namespace alook_touch {
inline constexpr int speaker_texture_side = 112;
inline constexpr int speaker_frame_count = 11;
inline constexpr int speaker_palette_count = 58;
extern const float speaker_palette[speaker_palette_count][5];
struct SpeakerPhotoPoint;
class SpeakerRenderer {
public:
  ~SpeakerRenderer();
  bool set_seed(const std::string& seed);
  bool set_texture(const uint8_t* texture);
  bool render(SpeakerIdle::Pose pose);
  bool set_halo(const lv_img_dsc_t* halo);
  void set_online(bool online) { online_ = online; }
  void finish_frame();
  void draw_face(const lv_img_dsc_t* eyes, int eyes_x, int eyes_y, const lv_img_dsc_t* mouth, int mouth_x, int mouth_y, SpeakerIdle::Pose pose, float time);
  const lv_img_dsc_t* image() const { return &image_; }
  void reset_source() { texture_ = nullptr; seed_.clear(); dirty_ = (1u << speaker_frame_count) - 1; }
  void set_reference_palette();
  void set_noise(const int8_t* noise);
  const uint8_t* frame(int index);
private:
  uint8_t* frames_[speaker_frame_count]{};
  uint8_t* scratch_ = nullptr;
  SpeakerPhotoPoint* photo_points_ = nullptr;
  uint8_t* halo_ = nullptr;
  bool online_ = false;
  uint16_t* canvas_ = nullptr;
  lv_img_dsc_t image_{};
  float colors_[speaker_palette_count][3]{};
  float exponent_[130]{};
  uint16_t index_[233]{};
  uint8_t fraction_[233]{};
  int8_t noise_[256]{};
  uint32_t vertical_rb_[speaker_texture_side]{};
  uint16_t vertical_g_[speaker_texture_side]{};
  alignas(4) uint32_t output_row_[233]{};
  uint16_t boundary_[466]{};
  uint8_t row_cache_[2][speaker_texture_side * 3 + 4]{};
  uint16_t dirty_ = (1u << speaker_frame_count) - 1;
  const uint8_t* texture_ = nullptr;
  std::string seed_;
  bool initialized_ = false;
  bool init();
  void generate(int index);
  bool init_photo();
  void sample_photo(float look_x);
  void blit(const lv_img_dsc_t* sprite, int first, int width, float origin_x, float origin_y, SpeakerIdle::Pose pose, float time, float openness);
};
}
