#include "image_art.h"
#include <AlookImages.h>
#include <esp_heap_caps.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace alook_touch {
ImageArt::~ImageArt() { clear(); }
void ImageArt::clear() { heap_caps_free(pixels_); pixels_ = nullptr; image_ = {}; }
bool ImageArt::decode(const std::string& bytes) {
  if (bytes.empty() || bytes.size() > 512 * 1024) return false;
  const auto* input = reinterpret_cast<const uint8_t*>(bytes.data());
  int width = 0, height = 0, channels = 0;
  uint8_t* rgba = nullptr;
  WebPAnimDecoder* animation = nullptr;
  bool webp = false;
  WebPBitstreamFeatures features{};
  if (WebPGetFeatures(input, bytes.size(), &features) == VP8_STATUS_OK) {
    width = features.width; height = features.height; webp = true;
    if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return false;
    if (features.has_animation) {
      WebPData data{input, bytes.size()}; WebPAnimDecoderOptions options;
      if (!WebPAnimDecoderOptionsInit(&options)) return false;
      options.color_mode = MODE_RGBA;
      animation = WebPAnimDecoderNew(&data, &options);
      int timestamp = 0;
      if (!animation || !WebPAnimDecoderGetNext(animation, &rgba, &timestamp)) { WebPAnimDecoderDelete(animation); return false; }
    } else rgba = WebPDecodeRGBA(input, bytes.size(), &width, &height);
  } else {
    if (!stbi_info_from_memory(input, bytes.size(), &width, &height, &channels) || width <= 0 || height <= 0 || width > 1024 || height > 1024) return false;
    rgba = stbi_load_from_memory(input, bytes.size(), &width, &height, &channels, 4);
  }
  if (!rgba) { WebPAnimDecoderDelete(animation); return false; }
  constexpr int side = 288;
  auto* scaled = static_cast<uint8_t*>(heap_caps_malloc(side * side * 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  const int crop = std::min(width, height), x = (width - crop) / 2, y = (height - crop) / 2;
  bool resized = scaled && stbir_resize_uint8_linear(rgba + (y * width + x) * 4, crop, crop, width * 4, scaled, side, side, side * 4, STBIR_RGBA);
  if (animation) WebPAnimDecoderDelete(animation);
  else if (webp) WebPFree(rgba);
  else stbi_image_free(rgba);
  if (!resized) { heap_caps_free(scaled); return false; }
  auto* pixels = static_cast<uint8_t*>(heap_caps_malloc(side * side * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels) { heap_caps_free(scaled); return false; }
  for (int y = 0; y < side; ++y) for (int x = 0; x < side; ++x) {
    const int index = y * side + x;
    const uint16_t rgb = (scaled[index * 4] >> 3) << 11 | (scaled[index * 4 + 1] >> 2) << 5 | (scaled[index * 4 + 2] >> 3);
    const float radius = std::hypot(x + 0.5f - side / 2, y + 0.5f - side / 2);
    const auto alpha = static_cast<uint8_t>(std::clamp((142 - radius) * 255, 0.0f, 255.0f));
    pixels[index * 3] = rgb; pixels[index * 3 + 1] = rgb >> 8; pixels[index * 3 + 2] = scaled[index * 4 + 3] * alpha / 255;
  }
  heap_caps_free(scaled);
  clear(); pixels_ = pixels;
  image_.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA; image_.header.w = side; image_.header.h = side; image_.data = pixels_; image_.data_size = side * side * 3;
  return true;
}
}
