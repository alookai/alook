/* SPDX-License-Identifier: MIT
Speaker c9ed3ef irGenFrame/animIdleRainbow and avProject/avBlend adapted to Alook data and a466px canvas; see third_party/NOTICE.md. */
#include "speaker_renderer.h"
#include "usb_mirror.h"
#include <esp_heap_caps.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace alook_touch {
struct SpeakerPhotoPoint { float depth, weight, red, green, blue; };
namespace {
constexpr int W = 466, H = 466, CX = 233, CY = 233, RADIUS = 233;
constexpr int IR_SPR = 112, IR_FRAMES = 11;
constexpr float IR_MAXROT = 30, IR_SIGMA2 = 2 * .16f * .16f, IR_CUTOFF2 = .55f * .55f;
constexpr float IR_SB = RADIUS * .13f, IR_DRAWN = W + 2 * IR_SB;
constexpr double PI = 3.1415926535897932384626433832795;
}
const float speaker_palette[][5] = {
    {-0.65, -0.65, 250, 209, 228}, {-0.43, -0.65, 248, 229, 157}, {-0.22, -0.65, 244, 213, 121},
    {0.00, -0.65, 228, 170, 144}, {0.22, -0.65, 214, 135, 150}, {0.43, -0.65, 185, 100, 129},
    {-0.65, -0.43, 251, 225, 208}, {-0.43, -0.43, 250, 229, 177}, {-0.22, -0.43, 236, 197, 99},
    {0.00, -0.43, 217, 160, 69}, {0.22, -0.43, 202, 140, 54}, {0.43, -0.43, 166, 99, 48},
    {-0.65, -0.22, 249, 233, 179}, {-0.43, -0.22, 245, 219, 152}, {-0.22, -0.22, 226, 166, 96},
    {0.00, -0.22, 207, 132, 71}, {0.22, -0.22, 177, 113, 29}, {0.43, -0.22, 140, 75, 25},
    {-0.65, 0.00, 229, 212, 104}, {-0.43, 0.00, 221, 195, 96}, {-0.22, 0.00, 211, 125, 138},
    {0.00, 0.00, 187, 86, 127}, {0.22, 0.00, 142, 60, 43}, {0.43, 0.00, 109, 41, 46},
    {-0.65, 0.22, 206, 194, 82}, {-0.43, 0.22, 190, 178, 80}, {-0.22, 0.22, 186, 110, 159},
    {0.00, 0.22, 163, 63, 140}, {0.22, 0.22, 120, 39, 85}, {0.43, 0.22, 92, 27, 71},
    {-0.65, 0.43, 196, 171, 83}, {-0.43, 0.43, 161, 164, 76}, {-0.22, 0.43, 141, 128, 133},
    {0.00, 0.43, 135, 53, 139}, {0.22, 0.43, 102, 31, 101}, {0.43, 0.43, 97, 30, 107},
    {-0.65, 0.65, 178, 99, 142}, {-0.43, 0.65, 133, 136, 66}, {-0.22, 0.65, 100, 113, 121},
    {0.00, 0.65, 98, 55, 125}, {0.22, 0.65, 103, 35, 117}, {0.43, 0.65, 109, 36, 117},
    {0.850, 0.000, 93, 95, 61}, {0.736, 0.425, 77, 68, 119}, {0.425, 0.736, 117, 40, 132},
    {0.000, 0.850, 80, 76, 143}, {-0.425, 0.736, 123, 111, 58}, {-0.736, 0.425, 208, 145, 145},
    {-0.850, 0.000, 241, 181, 177}, {-0.736, -0.425, 251, 214, 202}, {-0.425, -0.736, 252, 234, 169},
    {0.000, -0.850, 232, 188, 213}, {0.425, -0.736, 192, 104, 162}, {0.736, -0.425, 103, 58, 52},
    {-0.797, -0.460, 250, 204, 211}, {-0.920, 0.000, 240, 166, 218},
    {0.000, -0.920, 233, 188, 223}, {0.460, -0.797, 184, 97, 168}};

static_assert(sizeof(speaker_palette) / sizeof(speaker_palette[0]) == speaker_palette_count);
SpeakerRenderer::~SpeakerRenderer() {
  lv_img_cache_invalidate_src(&image_);
  for (auto* frame : frames_) heap_caps_free(frame);
  heap_caps_free(scratch_); heap_caps_free(canvas_); heap_caps_free(photo_points_); heap_caps_free(halo_);
}
bool SpeakerRenderer::init() {
  if (initialized_) return true;
  for (auto& frame : frames_) if (!frame) frame = static_cast<uint8_t*>(heap_caps_malloc(IR_SPR * IR_SPR * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!scratch_) scratch_ = static_cast<uint8_t*>(heap_caps_malloc(IR_SPR * IR_SPR * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!canvas_) canvas_ = static_cast<uint16_t*>(heap_caps_malloc(W * H * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!scratch_ || !canvas_) return false;
  for (const auto* frame : frames_) if (!frame) return false;
  for (int x = 0; x < W / 2; ++x) {
    float tf = (2 * x + .5f + IR_SB) * IR_SPR / IR_DRAWN - .5f;
    tf = std::clamp(tf, 0.0f, static_cast<float>(IR_SPR - 2));
    index_[x] = static_cast<uint16_t>(tf); fraction_[x] = static_cast<uint8_t>((tf - static_cast<int>(tf)) * 16);
  }
  for (int y = 0; y < H; ++y) {
    const float dy = y + .5f - CY;
    boundary_[y] = static_cast<uint16_t>(std::ceil(CX - std::sqrt(std::max(0.0f, RADIUS * RADIUS - dy * dy)) - .5f));
  }
  uint32_t random = 0x937ad251u;
  for (auto& value : noise_) { random ^= random << 13; random ^= random >> 17; random ^= random << 5; value = random & 7; }
  for (int i = 0; i < 130; ++i) exponent_[i] = expf(-(i * (IR_CUTOFF2 / 128.0f)) / IR_SIGMA2);
  image_.header.cf = LV_IMG_CF_TRUE_COLOR; image_.header.w = W; image_.header.h = H;
  image_.data = reinterpret_cast<const uint8_t*>(canvas_); image_.data_size = W * H * sizeof(uint16_t);
  initialized_ = true;
  return true;
}
bool SpeakerRenderer::set_seed(const std::string& seed) {
  if (!init()) return false;
  if (!texture_ && seed_ == seed && !seed_.empty()) return true;
  seed_ = seed; texture_ = nullptr;
  const auto identity = avatar_identity(seed);
  for (int k = 0; k < speaker_palette_count; ++k) {
    const auto color = identity.color;
    colors_[k][0] = color >> 16; colors_[k][1] = (color >> 8) & 255; colors_[k][2] = color & 255;
  }
  dirty_ = (1u << IR_FRAMES) - 1;
  return true;
}
bool SpeakerRenderer::set_texture(const uint8_t* texture) {
  if (!texture || !init() || !init_photo()) return false;
  if (texture_ != texture) { texture_ = texture; seed_.clear(); dirty_ = (1u << IR_FRAMES) - 1; }
  return true;
}
void SpeakerRenderer::set_reference_palette() {
  if (!init()) return;
  texture_ = nullptr; seed_.clear(); dirty_ = (1u << IR_FRAMES) - 1;
  for (int k = 0; k < speaker_palette_count; ++k) for (int c = 0; c < 3; ++c) colors_[k][c] = speaker_palette[k][c + 2];
}
void SpeakerRenderer::set_noise(const int8_t* noise) { if (init()) std::memcpy(noise_, noise, sizeof(noise_)); }
const uint8_t* SpeakerRenderer::frame(int index) {
  if (!init() || index < 0 || index >= IR_FRAMES) return nullptr;
  if (dirty_ & (1u << index)) { generate(index); dirty_ &= ~(1u << index); }
  return frames_[index];
}
void SpeakerRenderer::generate(int fi)
{
  const float rotDeg = -IR_MAXROT + fi * (2 * IR_MAXROT / (IR_FRAMES - 1));
  const float theta = rotDeg * PI / 180.0f;
  const float cosT = cosf(theta), sinT = sinf(theta);
  const float satBoost = 1.75f, lumBoost = 1.12f;
  const float d2toLut = 128.0f / IR_CUTOFF2;
  const float rTex = IR_SPR * 229.0f / 466.0f;
  float rpx[speaker_palette_count], rpy[speaker_palette_count], rvis[speaker_palette_count];
  for (unsigned k = 0; k < speaker_palette_count; k++)
  {
    float nx = speaker_palette[k][0], ny = speaker_palette[k][1];
    float nzsq = 1 - nx * nx - ny * ny;
    float nz = nzsq > 0 ? sqrtf(nzsq) : 0;
    float nxr = nx * cosT + nz * sinT;
    float nzr = -nx * sinT + nz * cosT;
    rpx[k] = nxr;
    rpy[k] = ny;
    float vis = nzsq > 0 ? std::max(0.0f, nzr) : 0.5f;
    rvis[k] = sqrtf(vis);
  }
  uint8_t *dst = frames_[fi];
  for (int y = 0; y < IR_SPR; y++)
    for (int x = 0; x < IR_SPR; x++)
    {
      float nx = (x - IR_SPR / 2.0f) / rTex, ny = (y - IR_SPR / 2.0f) / rTex;
      float pr = 0, pg = 0, pb = 0;
      if (nx * nx + ny * ny <= 1.0f)
      {
        if (texture_) {
          const float depth = sqrtf(std::max(0.0f, 1 - nx * nx - ny * ny));
          const int tx = std::clamp(static_cast<int>((nx * cosT - depth * sinT) * rTex + IR_SPR / 2), 0, IR_SPR - 1);
          const auto* pixel = texture_ + (y * IR_SPR + tx) * 3;
          pr = pixel[0]; pg = pixel[1]; pb = pixel[2];
        } else {
        float tw = 0;
        for (unsigned k = 0; k < speaker_palette_count; k++)
        {
          float ddx = nx - rpx[k], ddy = ny - rpy[k];
          float d2 = ddx * ddx + ddy * ddy;
          if (d2 > IR_CUTOFF2)
            continue;
          float w = exponent_[(int)(d2 * d2toLut)] * rvis[k];
          tw += w;
          pr += colors_[k][0] * w;
          pg += colors_[k][1] * w;
          pb += colors_[k][2] * w;
        }
        if (tw > 1e-6f)
        {
          pr /= tw;
          pg /= tw;
          pb /= tw;
          float lum = 0.299f * pr + 0.587f * pg + 0.114f * pb;
          pr = (lum + (pr - lum) * satBoost) * lumBoost;
          pg = (lum + (pg - lum) * satBoost) * lumBoost;
          pb = (lum + (pb - lum) * satBoost) * lumBoost;
        }
        }
      }
      float sx = -IR_SB + (x + 0.5f) * IR_DRAWN / IR_SPR;
      float sy = -IR_SB + (y + 0.5f) * IR_DRAWN / IR_SPR;
      float dxc = sx - CX, dyc = sy - CY;
      float rr = sqrtf(dxc * dxc + dyc * dyc) / RADIUS;
      float a;
      if (rr < 0.60f)
        a = rr / 0.60f * 0.22f;
      else if (rr < 0.88f)
        a = 0.22f + (rr - 0.60f) / 0.28f * 0.48f;
      else
        a = std::min(1.0f, 0.70f + (rr - 0.88f) / 0.12f * 0.30f);
      pr = pr * (1 - a) + 12 * a;
      pg = pg * (1 - a) + 7 * a;
      pb = pb * (1 - a) + 20 * a;
      float d1x = sx - (CX - RADIUS * 0.35f), d1y = sy - (CY - RADIUS * 0.45f);
      float u1 = sqrtf(d1x * d1x + d1y * d1y) / (RADIUS * 0.42f);
      if (u1 < 1)
      {
        float ha;
        if (u1 < 0.3f)
          ha = 0.55f - u1 / 0.3f * 0.25f;
        else if (u1 < 0.6f)
          ha = 0.30f - (u1 - 0.3f) / 0.3f * 0.20f;
        else
          ha = 0.10f * (1 - (u1 - 0.6f) / 0.4f);
        pr += 255 * ha;
        pg += 244 * ha;
        pb += 205 * ha;
      }
      float d2x = sx - (CX + RADIUS * 0.55f), d2y = sy - (CY - RADIUS * 0.20f);
      float u2 = sqrtf(d2x * d2x + d2y * d2y) / (RADIUS * 0.25f);
      if (u2 < 1)
      {
        float ha = 0.30f * (1 - u2);
        pr += 255 * ha;
        pg += 220 * ha;
        pb += 230 * ha;
      }
      uint8_t *px = &dst[(y * IR_SPR + x) * 3];
      px[0] = (uint8_t)std::max(0.0f, std::min(255.0f, pr));
      px[1] = (uint8_t)std::max(0.0f, std::min(255.0f, pg));
      px[2] = (uint8_t)std::max(0.0f, std::min(255.0f, pb));
    }
}

bool SpeakerRenderer::init_photo() {
  if (photo_points_) return true;
  photo_points_ = static_cast<SpeakerPhotoPoint*>(heap_caps_malloc(IR_SPR * IR_SPR * sizeof(SpeakerPhotoPoint), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!photo_points_) return false;
  const float rTex = IR_SPR * 229.0f / 466.0f;
  for (int y = 0; y < IR_SPR; ++y) for (int x = 0; x < IR_SPR; ++x) {
    const float nx = (x - IR_SPR / 2.0f) / rTex, ny = (y - IR_SPR / 2.0f) / rTex;
    const float depth2 = 1 - nx * nx - ny * ny;
    float pr = 0, pg = 0, pb = 0;
      float sx = -IR_SB + (x + 0.5f) * IR_DRAWN / IR_SPR;
      float sy = -IR_SB + (y + 0.5f) * IR_DRAWN / IR_SPR;
      float dxc = sx - CX, dyc = sy - CY;
      float rr = sqrtf(dxc * dxc + dyc * dyc) / RADIUS;
      float a;
      if (rr < 0.60f)
        a = rr / 0.60f * 0.22f;
      else if (rr < 0.88f)
        a = 0.22f + (rr - 0.60f) / 0.28f * 0.48f;
      else
        a = std::min(1.0f, 0.70f + (rr - 0.88f) / 0.12f * 0.30f);
      pr = pr * (1 - a) + 12 * a;
      pg = pg * (1 - a) + 7 * a;
      pb = pb * (1 - a) + 20 * a;
      float d1x = sx - (CX - RADIUS * 0.35f), d1y = sy - (CY - RADIUS * 0.45f);
      float u1 = sqrtf(d1x * d1x + d1y * d1y) / (RADIUS * 0.42f);
      if (u1 < 1)
      {
        float ha;
        if (u1 < 0.3f)
          ha = 0.55f - u1 / 0.3f * 0.25f;
        else if (u1 < 0.6f)
          ha = 0.30f - (u1 - 0.3f) / 0.3f * 0.20f;
        else
          ha = 0.10f * (1 - (u1 - 0.6f) / 0.4f);
        pr += 255 * ha;
        pg += 244 * ha;
        pb += 205 * ha;
      }
      float d2x = sx - (CX + RADIUS * 0.55f), d2y = sy - (CY - RADIUS * 0.20f);
      float u2 = sqrtf(d2x * d2x + d2y * d2y) / (RADIUS * 0.25f);
      if (u2 < 1)
      {
        float ha = 0.30f * (1 - u2);
        pr += 255 * ha;
        pg += 220 * ha;
        pb += 230 * ha;
      }

    photo_points_[y * IR_SPR + x] = {depth2 < 0 ? -1 : sqrtf(depth2), 1 - a, pr, pg, pb};
  }
  return true;
}
void SpeakerRenderer::sample_photo(float look_x) {
  const float theta = look_x * IR_MAXROT * PI / 180.0f;
  const float cosine = cosf(theta), sine = sinf(theta), rTex = IR_SPR * 229.0f / 466.0f;
  for (int y = 0; y < IR_SPR; ++y) {
    std::memcpy(row_cache_[0], texture_ + y * IR_SPR * 3, IR_SPR * 3);
    const auto* row = row_cache_[0];
    for (int x = 0; x < IR_SPR; ++x) {
      const auto point = photo_points_[y * IR_SPR + x];
      float rgb[3]{};
      if (point.depth >= 0) {
        const float coordinate = std::clamp((x - IR_SPR / 2.0f) * cosine - point.depth * rTex * sine + IR_SPR / 2.0f, 0.0f, static_cast<float>(IR_SPR - 1));
        const int left = static_cast<int>(coordinate), right = std::min(IR_SPR - 1, left + 1);
        const float fraction = coordinate - left;
        for (int channel = 0; channel < 3; ++channel) rgb[channel] = row[left * 3 + channel] * (1 - fraction) + row[right * 3 + channel] * fraction;
      }
      auto* target = scratch_ + (y * IR_SPR + x) * 3;
      target[0] = static_cast<uint8_t>(std::clamp(rgb[0] * point.weight + point.red, 0.0f, 255.0f));
      target[1] = static_cast<uint8_t>(std::clamp(rgb[1] * point.weight + point.green, 0.0f, 255.0f));
      target[2] = static_cast<uint8_t>(std::clamp(rgb[2] * point.weight + point.blue, 0.0f, 255.0f));
    }
  }
}

bool SpeakerRenderer::render(SpeakerIdle::Pose pose) {
  if (!init()) return false;
  const float lookX = std::clamp(pose.x, -1.0f, 1.0f);
  const float fidx = (lookX * IR_MAXROT + IR_MAXROT) / (2 * IR_MAXROT / (IR_FRAMES - 1));
  const int lo = std::clamp(static_cast<int>(fidx), 0, IR_FRAMES - 2);
  const auto temporal_started = usb_mirror_micros();
  const uint8_t* tex;
  if (texture_) { sample_photo(lookX); tex = scratch_; }
  else {
  bool shown = false;
  for (int index : {lo, lo + 1}) if (dirty_ & (1u << index)) { frame(index); shown = true; }
  if (!shown) for (int index = 0; index < IR_FRAMES; ++index) if (dirty_ & (1u << index)) { frame(index); break; }
  int alpha16 = (int)((fidx - lo) * 16);
  const uint8_t *texA = frames_[lo], *texB = frames_[lo + 1];

  if (alpha16 <= 0)
    tex = texA;
  else if (alpha16 >= 16)
    tex = texB;
  else
  {
    const int inv = 16 - alpha16;
    for (int i = 0; i < IR_SPR * IR_SPR * 3; i++)
      scratch_[i] = (uint8_t)((texA[i] * inv + texB[i] * alpha16) >> 4);
    tex = scratch_;
  }

  }
  const auto halo_started = usb_mirror_micros();
  usb_mirror_profile(texture_ ? PhotoUs : TemporalUs, halo_started - temporal_started);
  usb_mirror_profile(texture_ ? TemporalUs : PhotoUs, 0);
  if (online_ && halo_) {
    if (tex != scratch_) std::memcpy(scratch_, tex, IR_SPR * IR_SPR * 3);
    for (int i = 0; i < IR_SPR * IR_SPR; ++i) {
      const auto* color = halo_ + i * 4; const int alpha = color[3];
      if (!alpha) continue;
      for (int channel = 0; channel < 3; ++channel) scratch_[i * 3 + channel] = (scratch_[i * 3 + channel] * (255 - alpha) + color[channel] * alpha + 127) / 255;
    }
    tex = scratch_;
  }
  const auto upscale_started = usb_mirror_micros();
  usb_mirror_profile(HaloUs, upscale_started - halo_started);
  uint16_t *fb = canvas_;
  auto& rowCache = row_cache_;
  int rowCached = -2;
  constexpr int yOff = 0;
  for (int y2 = 0; y2 < H / 2; y2++)
  {
    int dy = y2 * 2 + yOff;
    uint16_t *d0 = (dy >= 0 && dy < H) ? &fb[dy * W] : nullptr;
    uint16_t *d1 = (dy + 1 >= 0 && dy + 1 < H) ? &fb[(dy + 1) * W] : nullptr;
    if (!d0 && !d1)
      continue;
    int srcRow = index_[y2];
    if (srcRow != rowCached)
    {
      if (srcRow == rowCached + 1)
      {
        memcpy(rowCache[0], rowCache[1], IR_SPR * 3);
        memcpy(rowCache[1], &tex[(srcRow + 1) * IR_SPR * 3], IR_SPR * 3);
      }
      else
      {
        memcpy(rowCache[0], &tex[srcRow * IR_SPR * 3], IR_SPR * 3);
        memcpy(rowCache[1], &tex[(srcRow + 1) * IR_SPR * 3], IR_SPR * 3);
      }
      rowCached = srcRow;
    }
    const uint8_t *rowA = rowCache[0];
    const uint8_t *rowB = rowCache[1];
    int fy = fraction_[y2];
    for (int i = 0; i < IR_SPR; ++i) {
      const auto* a = rowA + i * 3; const auto* b = rowB + i * 3;
      vertical_rb_[i] = static_cast<uint32_t>(a[0] * (16 - fy) + b[0] * fy) | static_cast<uint32_t>(a[2] * (16 - fy) + b[2] * fy) << 16;
      vertical_g_[i] = a[1] * (16 - fy) + b[1] * fy;
    }
    for (int x2 = 0; x2 < W / 2; x2++)
    {
      const int tx = index_[x2], fx = fraction_[x2];
      const uint32_t rb = vertical_rb_[tx] * (16 - fx) + vertical_rb_[tx + 1] * fx;
      int r = (rb >> 8) & 255;
      int g = (vertical_g_[tx] * (16 - fx) + vertical_g_[tx + 1] * fx) >> 8;
      int b = rb >> 24;
      int d8 = noise_[(x2 * 7 + y2 * 131) & 255];
      r += d8;
      g += d8 >> 1;
      b += noise_[(x2 * 131 + y2 * 7 + 97) & 255];
      uint16_t c = (uint16_t)(((r > 255 ? 31 : r >> 3) << 11) |
                              ((g > 255 ? 63 : g >> 2) << 5) |
                              (b > 255 ? 31 : b >> 3));
      output_row_[x2] = c | static_cast<uint32_t>(c) << 16;
    }
    if (d0) std::memcpy(d0, output_row_, W * sizeof(uint16_t));
    if (d1) std::memcpy(d1, output_row_, W * sizeof(uint16_t));
  }

  lv_img_cache_invalidate_src(&image_);
  usb_mirror_profile(UpscaleUs, usb_mirror_micros() - upscale_started);
  return true;
}
bool SpeakerRenderer::set_halo(const lv_img_dsc_t* halo) {
  if (!halo || !halo->data || halo->header.cf != LV_IMG_CF_TRUE_COLOR_ALPHA) return false;
  if (!halo_) halo_ = static_cast<uint8_t*>(heap_caps_malloc(IR_SPR * IR_SPR * 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!halo_) return false;
  for (int y = 0; y < IR_SPR; ++y) for (int x = 0; x < IR_SPR; ++x) {
    auto* target = halo_ + (y * IR_SPR + x) * 4;
    const int sx = static_cast<int>(std::floor(-IR_SB + (x + .5f) * IR_DRAWN / IR_SPR));
    const int sy = static_cast<int>(std::floor(-IR_SB + (y + .5f) * IR_DRAWN / IR_SPR));
    if (sx < 0 || sy < 0 || sx >= halo->header.w || sy >= halo->header.h) { std::memset(target, 0, 4); continue; }
    const auto* source = halo->data + (sy * halo->header.w + sx) * 3;
    const uint16_t rgb = source[0] | source[1] << 8;
    target[0] = (rgb >> 11) * 255 / 31; target[1] = ((rgb >> 5) & 63) * 255 / 63;
    target[2] = (rgb & 31) * 255 / 31; target[3] = source[2];
  }
  return true;
}
void SpeakerRenderer::finish_frame() {
  if (!canvas_) return;
  const auto started = usb_mirror_micros();
  for (int y = 0; y < H; ++y) {
    const int left = boundary_[y];
    std::memset(canvas_ + y * W, 0, left * sizeof(uint16_t));
    std::memset(canvas_ + (y + 1) * W - left, 0, left * sizeof(uint16_t));
  }
  usb_mirror_profile(MaskUs, usb_mirror_micros() - started);
}

void SpeakerRenderer::blit(const lv_img_dsc_t* sprite, int first, int width, float origin_x, float origin_y, SpeakerIdle::Pose pose, float time, float openness) {
  if (!sprite || !sprite->data || width <= 0) return;
  constexpr float scale = RADIUS / 142.0f;
  const float source_cx = origin_x + first + width / 2.0f;
  const float source_cy = origin_y + sprite->header.h / 2.0f;
  const auto projected = sphere_feature((source_cx - 144) * scale + CX, (source_cy - 144) * scale + CY, pose.x, pose.y, time, RADIUS);
  const float draw_width = width * scale * projected.width;
  const float draw_height = std::max(2.0f, sprite->header.h * scale * openness);
  const float left = projected.x - draw_width / 2, top = projected.y - draw_height / 2;
  const int x0 = std::max(0, static_cast<int>(std::floor(left))), x1 = std::min(W, static_cast<int>(std::ceil(left + draw_width)));
  const int y0 = std::max(0, static_cast<int>(std::floor(top))), y1 = std::min(H, static_cast<int>(std::ceil(top + draw_height)));
  const int step_x = static_cast<int>(width * 65536.0f / draw_width), step_y = static_cast<int>(sprite->header.h * 65536.0f / draw_height);
  const int start_x = static_cast<int>((x0 + .5f - left) * width * 65536.0f / draw_width);
  int sy = static_cast<int>((y0 + .5f - top) * sprite->header.h * 65536.0f / draw_height);
  for (int y = y0; y < y1; ++y, sy += step_y) {
    const int source_y = std::clamp(sy >> 16, 0, static_cast<int>(sprite->header.h) - 1);
    int sx = start_x;
    for (int x = x0; x < x1; ++x, sx += step_x) {
      const int source_x = first + std::clamp(sx >> 16, 0, width - 1);
      const auto* pixel = sprite->data + (source_y * sprite->header.w + source_x) * 3;
      const int alpha = pixel[2];
      if (!alpha) continue;
      const uint16_t ink = pixel[0] | pixel[1] << 8;
      auto& target = canvas_[y * W + x];
      if (alpha == 255) { target = ink; continue; }
      const int dr = (target >> 11) & 31, dg = (target >> 5) & 63, db = target & 31;
      const int r = dr + (static_cast<int>((ink >> 11) & 31) - dr) * alpha / 255;
      const int g = dg + (static_cast<int>((ink >> 5) & 63) - dg) * alpha / 255;
      const int b = db + (static_cast<int>(ink & 31) - db) * alpha / 255;
      target = r << 11 | g << 5 | b;
    }
  }
}
void SpeakerRenderer::draw_face(const lv_img_dsc_t* eyes, int eyes_x, int eyes_y, const lv_img_dsc_t* mouth, int mouth_x, int mouth_y, SpeakerIdle::Pose pose, float time) {
  if (!canvas_) return;
  if (eyes) {
    const int split = eyes->header.w / 2;
    blit(eyes, 0, split, eyes_x, eyes_y, pose, time, pose.eyes);
    blit(eyes, split, eyes->header.w - split, eyes_x, eyes_y, pose, time, pose.eyes);
  }
  if (mouth) blit(mouth, 0, mouth->header.w, mouth_x, mouth_y, pose, time, 1);
}
}
