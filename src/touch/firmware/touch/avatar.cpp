/* SPDX-License-Identifier: MIT
Speaker anims_extra.h irGenFrame rim/highlight shading adapted to Alook face color; see third_party/NOTICE.md. */
#include "avatar.h"
#include "generated/face_assets.h"
#include <algorithm>
#include <cmath>
#include <esp_heap_caps.h>

namespace alook_touch {
FeatureArt::~FeatureArt() { heap_caps_free(pixels_); }
bool FeatureArt::make_halo() {
  constexpr int size = 466;
  lv_img_cache_invalidate_src(&image_);
  heap_caps_free(pixels_);
  pixels_ = static_cast<uint8_t*>(heap_caps_malloc(size * size * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  image_ = {};
  if (!pixels_) return false;
  for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
    const float dx = x + 0.5f - 233, dy = y + 0.5f - 233;
    const float radius = std::hypot(dx, dy);
    const float inset = 233 - radius;
    const float angle = std::atan2(dy, dx);
    const float wave = std::sin(angle * 3 + 0.8f);
    const float center = 19 + wave * 7 + std::sin(angle * 5 - 0.7f) * 4;
    const float sigma = 11 + (std::sin(angle * 2 - 0.5f) + 1) * 3;
    const float distance = (inset - center) / sigma;
    const float broad = (inset - 22) / 25;
    const float brightness = 0.38f + (std::sin(angle * 2 + 1.4f) + 1) * 0.25f;
    const float edge = std::clamp(inset / 15, 0.0f, 1.0f);
    const float fade = edge * edge * (3 - 2 * edge);
    const float strength = inset < 0 ? 0 : brightness * fade * (0.78f * std::exp(-distance * distance / 2) + 0.15f * std::exp(-broad * broad / 2));
    const int red = 34 + (wave + 1) * 18;
    const int green = 216 + (std::sin(angle * 2 - 0.3f) + 1) * 17;
    const int blue = 105 + (std::sin(angle * 3 + 2) + 1) * 24;
    const uint16_t color = (red >> 3) << 11 | (green >> 2) << 5 | (blue >> 3);
    auto* pixel = pixels_ + (y * size + x) * 3;
    pixel[0] = color; pixel[1] = color >> 8;
    pixel[2] = std::clamp(strength * 255, 0.0f, 255.0f);
  }
  image_.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA; image_.header.w = size; image_.header.h = size;
  image_.data = pixels_; image_.data_size = size * size * 3;
  return true;
}

bool FeatureArt::load(const lv_img_dsc_t* source) {
  const int width = source->header.w, height = source->header.h;
  lv_img_cache_invalidate_src(&image_);
  heap_caps_free(pixels_);
  pixels_ = static_cast<uint8_t*>(heap_caps_malloc(width * height * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  image_ = {};
  if (!pixels_) return false;
  const int stride = (width + 1) / 2;
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    const int value = source->data[64 + y * stride + x / 2];
    const int index = (value >> (x % 2 ? 0 : 4)) & 15;
    const auto* pixel = source->data + index * 4;
    const uint16_t color = (pixel[2] >> 3) << 11 | (pixel[1] >> 2) << 5 | (pixel[0] >> 3);
    auto* target = pixels_ + (y * width + x) * 3;
    target[0] = color; target[1] = color >> 8; target[2] = pixel[3];
  }
  image_.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA;
  image_.header.w = width; image_.header.h = height;
  image_.data = pixels_; image_.data_size = width * height * 3;
  return true;
}

AvatarArt::~AvatarArt() { heap_caps_free(pixels_); }
bool AvatarArt::set_seed(const std::string& seed, bool include_face) {
  identity = avatar_identity(seed);
  constexpr int size = 288;
  if (!pixels_) pixels_ = static_cast<uint8_t*>(heap_caps_malloc(size * size * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels_) return false;
  for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
    const float nx = (x + 0.5f - size / 2) / 142, ny = (y + 0.5f - size / 2) / 142;
    const float radius = std::hypot(nx, ny);
    auto* out = pixels_ + (y * size + x) * 3;
    if (radius >= 1) { out[0] = out[1] = out[2] = 0; continue; }
    const float shade = radius < 0.60f ? radius / 0.60f * 0.22f : radius < 0.88f ? 0.22f + (radius - 0.60f) / 0.28f * 0.48f : std::min(1.0f, 0.70f + (radius - 0.88f) / 0.12f * 0.30f);
    float red = (identity.color >> 16) * (1 - shade) + 12 * shade;
    float green = ((identity.color >> 8) & 255) * (1 - shade) + 7 * shade;
    float blue = (identity.color & 255) * (1 - shade) + 20 * shade;
    const float primary = std::hypot(nx + 0.35f, ny + 0.45f) / 0.42f;
    if (primary < 1) {
      const float alpha = primary < 0.3f ? 0.55f - primary / 0.3f * 0.25f : primary < 0.6f ? 0.30f - (primary - 0.3f) / 0.3f * 0.20f : 0.10f * (1 - (primary - 0.6f) / 0.4f);
      red += 255 * alpha; green += 244 * alpha; blue += 205 * alpha;
    }
    const float secondary = std::hypot(nx - 0.55f, ny + 0.20f) / 0.25f;
    if (secondary < 1) { const float alpha = 0.30f * (1 - secondary); red += 255 * alpha; green += 220 * alpha; blue += 230 * alpha; }
    const uint16_t color = (static_cast<int>(std::clamp(red, 0.0f, 255.0f)) >> 3) << 11
      | (static_cast<int>(std::clamp(green, 0.0f, 255.0f)) >> 2) << 5 | (static_cast<int>(std::clamp(blue, 0.0f, 255.0f)) >> 3);
    out[0] = color; out[1] = color >> 8; out[2] = std::min(255.0f, (1 - radius) * 142 * 255);
  }
  if (include_face) {
    for (const auto& feature : {assets::eyes[identity.eyes], assets::mouth[identity.mouth]}) {
      const auto* sprite = feature.image;
      const int stride = (sprite->header.w + 1) / 2;
      for (int y = 0; y < sprite->header.h; ++y) for (int x = 0; x < sprite->header.w; ++x) {
        const int packed = sprite->data[64 + y * stride + x / 2];
        const int index = (packed >> (x % 2 ? 0 : 4)) & 15;
        const auto* color = sprite->data + index * 4;
        const int alpha = color[3];
        if (!alpha) continue;
        auto* target = pixels_ + ((y + feature.y - 44) * size + x + feature.x) * 3;
        const uint16_t old = target[0] | target[1] << 8;
        const int red = (((old >> 11) * 255 / 31) * (255 - alpha) + color[2] * alpha) / 255;
        const int green = ((((old >> 5) & 63) * 255 / 63) * (255 - alpha) + color[1] * alpha) / 255;
        const int blue = (((old & 31) * 255 / 31) * (255 - alpha) + color[0] * alpha) / 255;
        const uint16_t result = (red >> 3) << 11 | (green >> 2) << 5 | (blue >> 3);
        target[0] = result; target[1] = result >> 8;
      }
    }
  }
  image_.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA; image_.header.w = size; image_.header.h = size;
  image_.data = pixels_; image_.data_size = size * size * 3;
  return true;
}
}
