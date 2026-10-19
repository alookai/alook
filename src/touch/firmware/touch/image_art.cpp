#include "image_art.h"
#include "usb_mirror.h"
#include <AlookImages.h>
#include <esp_heap_caps.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#ifdef ESP_PLATFORM
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#endif

namespace alook_touch {
ImageArt::~ImageArt() { clear(); }
DecodedImage::~DecodedImage() { heap_caps_free(pixels); }
void ImageArt::clear() { if (asset_) { lv_img_cache_invalidate_src(&asset_->image); } asset_.reset(); }
void ImageArt::set(std::shared_ptr<DecodedImage> asset) { if (asset_ != asset) { clear(); asset_ = std::move(asset); } }
bool ImageArt::decode(const std::string& bytes) { auto asset = decode_image(bytes); if (!asset) return false; set(std::move(asset)); return true; }
std::shared_ptr<DecodedImage> decode_image(const std::string& bytes, bool turn) {
#if ALOOK_TOUCH_USB_MIRROR
  struct Timing {
    uint32_t started = lv_tick_get();
    ~Timing() { usb_mirror_work(true, lv_tick_get() - started); }
  } timing;
#endif
  if (bytes.empty() || bytes.size() > 512 * 1024) return {};
  const auto* input = reinterpret_cast<const uint8_t*>(bytes.data());
  int width = 0, height = 0, channels = 0;
  uint8_t* rgba = nullptr;
  WebPAnimDecoder* animation = nullptr;
  bool webp = false;
  WebPBitstreamFeatures features{};
  if (WebPGetFeatures(input, bytes.size(), &features) == VP8_STATUS_OK) {
    width = features.width; height = features.height; webp = true;
    if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return {};
    if (features.has_animation) {
      WebPData data{input, bytes.size()}; WebPAnimDecoderOptions options;
      if (!WebPAnimDecoderOptionsInit(&options)) return {};
      options.color_mode = MODE_RGBA;
      animation = WebPAnimDecoderNew(&data, &options);
      int timestamp = 0;
      if (!animation || !WebPAnimDecoderGetNext(animation, &rgba, &timestamp)) { WebPAnimDecoderDelete(animation); return {}; }
    } else rgba = WebPDecodeRGBA(input, bytes.size(), &width, &height);
  } else {
    if (!stbi_info_from_memory(input, bytes.size(), &width, &height, &channels) || width <= 0 || height <= 0 || width > 1024 || height > 1024) return {};
    rgba = stbi_load_from_memory(input, bytes.size(), &width, &height, &channels, 4);
  }
  if (!rgba) { WebPAnimDecoderDelete(animation); return {}; }
  constexpr int side = 466;
  auto* scaled = static_cast<uint8_t*>(heap_caps_malloc(side * side * 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  const int crop = std::min(width, height), x = (width - crop) / 2, y = (height - crop) / 2;
  bool resized = scaled && stbir_resize_uint8_linear(rgba + (y * width + x) * 4, crop, crop, width * 4, scaled, side, side, side * 4, STBIR_RGBA);
  if (animation) WebPAnimDecoderDelete(animation);
  else if (webp) WebPFree(rgba);
  else stbi_image_free(rgba);
  if (!resized) { heap_caps_free(scaled); return {}; }
  auto* pixels = static_cast<uint8_t*>(heap_caps_malloc((side * side * 3 + (turn ? 112 * 112 * 3 : 0)), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels) { heap_caps_free(scaled); return {}; }
  for (int y = 0; y < side; ++y) for (int x = 0; x < side; ++x) {
    const int index = y * side + x;
    const uint16_t rgb = (scaled[index * 4] >> 3) << 11 | (scaled[index * 4 + 1] >> 2) << 5 | (scaled[index * 4 + 2] >> 3);
    const float radius = std::hypot(x + 0.5f - side / 2, y + 0.5f - side / 2);
    const auto alpha = static_cast<uint8_t>(std::clamp((side / 2.0f - radius) * 255, 0.0f, 255.0f));
    pixels[index * 3] = rgb; pixels[index * 3 + 1] = rgb >> 8; pixels[index * 3 + 2] = scaled[index * 4 + 3] * alpha / 255;
  }
  if (turn) for (int y = 0; y < 112; ++y) for (int x = 0; x < 112; ++x) {
    const auto* input = scaled + ((y * side / 112) * side + x * side / 112) * 4;
    auto* target = pixels + side * side * 3 + (y * 112 + x) * 3;
    for (int channel = 0; channel < 3; ++channel) target[channel] = input[channel] * input[3] / 255;
  }
  heap_caps_free(scaled);
  auto asset = std::make_shared<DecodedImage>();
  asset->pixels = pixels;
  asset->image.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA; asset->image.header.w = side; asset->image.header.h = side;
  asset->image.data = pixels; asset->image.data_size = side * side * 3;
  if (turn) asset->texture = pixels + side * side * 3;
  return asset;
}
}
