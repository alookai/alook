/* SPDX-License-Identifier: MIT
Speaker anims_extra.h irGenFrame rim/highlight shading adapted to Alook face color; see third_party/NOTICE.md. */
#include "avatar.h"
#include "generated/face_assets.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <esp_heap_caps.h>

namespace alook_touch {
namespace {
struct BodyLight { uint8_t weight, red, green, blue, alpha; };
BodyLight* body_lights = nullptr;
BodyLight body_light(int x, int y) {
  const float nx = (x + .5f - 144) / 142, ny = (y + .5f - 144) / 142;
  const float radius = std::hypot(nx, ny);
  if (radius >= 1) return {};
  const float shade = radius < .60f ? radius / .60f * .22f : radius < .88f ? .22f + (radius - .60f) / .28f * .48f : std::min(1.0f, .70f + (radius - .88f) / .12f * .30f);
  const float primary = std::hypot(nx + .35f, ny + .45f) / .42f;
  const float first = primary >= 1 ? 0 : primary < .3f ? .55f - primary / .3f * .25f : primary < .6f ? .30f - (primary - .3f) / .3f * .20f : .10f * (1 - (primary - .6f) / .4f);
  const float secondary = std::hypot(nx - .55f, ny + .20f) / .25f;
  const float second = secondary < 1 ? .30f * (1 - secondary) : 0;
  return {static_cast<uint8_t>((1 - shade) * 255), static_cast<uint8_t>(12 * shade + 255 * first + 255 * second),
    static_cast<uint8_t>(7 * shade + 244 * first + 220 * second), static_cast<uint8_t>(20 * shade + 205 * first + 230 * second),
    static_cast<uint8_t>(std::min(255.0f, (1 - radius) * 142 * 255))};
}
}
FeatureArt::~FeatureArt() { heap_caps_free(pixels_); heap_caps_free(projected_pixels_); heap_caps_free(depths_); }
void FeatureArt::swap(FeatureArt& other) {
  lv_img_cache_invalidate_src(&image_); lv_img_cache_invalidate_src(&other.image_);
  lv_img_cache_invalidate_src(&projected_); lv_img_cache_invalidate_src(&other.projected_);
  std::swap(pixels_, other.pixels_); std::swap(image_, other.image_);
  std::swap(projected_pixels_, other.projected_pixels_); std::swap(projected_, other.projected_);
  std::swap(depths_, other.depths_); std::swap(projected_angle_, other.projected_angle_);
  std::swap(origin_x_, other.origin_x_); std::swap(origin_y_, other.origin_y_); std::swap(projected_left_, other.projected_left_);
}
void FeatureArt::reset_projection() {
  lv_img_cache_invalidate_src(&projected_); heap_caps_free(projected_pixels_); projected_pixels_ = nullptr; projected_ = {};
  heap_caps_free(depths_); depths_ = nullptr; projected_angle_ = -1000; origin_x_ = origin_y_ = -1; projected_left_ = 0;
}
const lv_img_dsc_t* FeatureArt::project(float look_x, int origin_x, int origin_y, bool& changed) {
  changed = false;
  if (!pixels_) return &image_;
  constexpr int width = 466;
  const int height = (image_.header.h * 466 + 287) / 288;
  if (!projected_pixels_) projected_pixels_ = static_cast<uint8_t*>(heap_caps_malloc(width * height * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!depths_) depths_ = static_cast<float*>(heap_caps_malloc(width * height * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!projected_pixels_ || !depths_) return &image_;
  if (origin_x != origin_x_ || origin_y != origin_y_) {
    origin_x_ = origin_x; origin_y_ = origin_y; projected_angle_ = -1000;
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
      const float nx = ((x + .5f) * 288 / 466 - 144) / 142;
      const float ny = ((y + .5f) * 288 / 466 + origin_y - 144) / 142;
      const float squared = 1 - nx * nx - ny * ny;
      depths_[y * width + x] = squared >= 0 ? std::sqrt(squared) : -1;
    }
  }
  const int angle = std::clamp(static_cast<int>(std::lround(look_x * 30)), -30, 30);
  if (angle == projected_angle_) return &projected_;
  projected_angle_ = angle; changed = true;
  const float theta = angle * 3.14159265358979323846f / 180;
  const float cosine = std::cos(theta), sine = std::sin(theta);
  int left = width, right = -1;
  lv_img_cache_invalidate_src(&projected_);
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    auto* target = projected_pixels_ + (y * width + x) * 3;
    const float depth = depths_[y * width + x];
    const float sx = ((x + .5f) * 288 / 466 - 144) * cosine - depth * 142 * sine + 144 - origin_x;
    const int source_x = static_cast<int>(std::floor(sx)), source_y = std::min<int>(image_.header.h - 1, y * 288 / 466);
    if (depth < 0 || source_x < 0 || source_x >= image_.header.w) { target[0] = target[1] = target[2] = 0; continue; }
    const auto* source = pixels_ + (source_y * image_.header.w + source_x) * 3;
    target[0] = source[0]; target[1] = source[1]; target[2] = source[2];
    if (target[2]) { left = std::min(left, x); right = std::max(right, x); }
  }
  if (right < left) { left = 0; right = 0; }
  const int cropped = right - left + 1;
  for (int y = 0; y < height; ++y) std::memmove(projected_pixels_ + y * cropped * 3, projected_pixels_ + (y * width + left) * 3, cropped * 3);
  projected_left_ = left;
  projected_ = image_; projected_.header.w = cropped; projected_.header.h = height;
  projected_.data_size = cropped * height * 3; projected_.data = projected_pixels_;
  return &projected_;
}
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
  reset_projection();
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
void AvatarArt::swap(AvatarArt& other) {
  lv_img_cache_invalidate_src(&image_); lv_img_cache_invalidate_src(&other.image_);
  std::swap(pixels_, other.pixels_); std::swap(image_, other.image_); std::swap(identity, other.identity); std::swap(capacity_, other.capacity_);
}
bool AvatarArt::set_seed(const std::string& seed, bool include_face) {
  identity = avatar_identity(seed);
  const int size = include_face ? 288 : 466, stride = include_face ? 3 : 2;
  const size_t required = size * size * stride;
  if (capacity_ != required) {
    auto* replacement = static_cast<uint8_t*>(heap_caps_realloc(pixels_, required, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!replacement) return false;
    pixels_ = replacement; capacity_ = required;
  }
  if (!body_lights) {
    body_lights = static_cast<BodyLight*>(heap_caps_malloc(288 * 288 * sizeof(BodyLight), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (body_lights) for (int y = 0; y < 288; ++y) for (int x = 0; x < 288; ++x) body_lights[y * 288 + x] = body_light(x, y);
  }
  for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
    const int lx = x * 288 / size, ly = y * 288 / size;
    const auto light = body_lights ? body_lights[ly * 288 + lx] : body_light(lx, ly);
    int red = std::min(255, static_cast<int>((identity.color >> 16) * light.weight / 255 + light.red));
    int green = std::min(255, static_cast<int>(((identity.color >> 8) & 255) * light.weight / 255 + light.green));
    int blue = std::min(255, static_cast<int>((identity.color & 255) * light.weight / 255 + light.blue));
    if (!include_face) { red = red * light.alpha / 255; green = green * light.alpha / 255; blue = blue * light.alpha / 255; }
    const uint16_t color = (red >> 3) << 11 | (green >> 2) << 5 | (blue >> 3);
    auto* out = pixels_ + (y * size + x) * stride;
    out[0] = color; out[1] = color >> 8; if (include_face) out[2] = light.alpha;
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
  image_.header.cf = include_face ? LV_IMG_CF_TRUE_COLOR_ALPHA : LV_IMG_CF_TRUE_COLOR; image_.header.w = size; image_.header.h = size;
  image_.data = pixels_; image_.data_size = size * size * stride;
  return true;
}
}
