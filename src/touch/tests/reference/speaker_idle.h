/* SPDX-License-Identifier: MIT
Unmodified idle renderer excerpts from Speaker c9ed3ef; see third_party/NOTICE.md. */
static const float PAL_RAINBOW[][5] = {
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
#define PAL_N (sizeof(PAL_RAINBOW) / sizeof(PAL_RAINBOW[0]))

#define IR_SPR 112
#define IR_FRAMES 11
#define IR_MAXROT 30.0f
#define IR_SIGMA2 (2 * 0.16f * 0.16f)
#define IR_CUTOFF2 (0.55f * 0.55f) // beyond this, gaussian weight negligible
static uint8_t *irFrames[IR_FRAMES]; // RGB888 (3 bytes/px): 8 bits/channel,
                                     // 565 quantization only happens at
                                     // the end (dithering) -> no banding
static uint8_t *irScratch = nullptr;
// bilinear resampling tables, half resolution -> texture
static uint16_t irTIdx[W / 2];
static uint8_t irTFrac[W / 2];
static int8_t irNoise[256];
static float irExpLUT[130]; // expf(-d2/sigma2) tabulated -> ~8x faster gen

// Same overscan as the JS: the sphere is a bit larger than the screen
#define IR_SB (RADIUS * 0.13f)
#define IR_DRAWN (W + 2 * IR_SB)

static void irInit()
{
  for (int i = 0; i < IR_FRAMES; i++)
    irFrames[i] = (uint8_t *)malloc(IR_SPR * IR_SPR * 3);
  irScratch = (uint8_t *)malloc(IR_SPR * IR_SPR * 3);
  // rendering runs at half resolution (2x2 blocks): sample at the center
  for (int x = 0; x < W / 2; x++)
  {
    float tf = (2 * x + 0.5f + IR_SB) * IR_SPR / IR_DRAWN - 0.5f;
    if (tf < 0)
      tf = 0;
    if (tf > IR_SPR - 2)
      tf = IR_SPR - 2;
    irTIdx[x] = (uint16_t)tf;
    irTFrac[x] = (uint8_t)((tf - (int)tf) * 16);
  }
  for (int i = 0; i < 256; i++)
    irNoise[i] = (int8_t)frand(0.0f, 8.0f); // ordered dither 0..7 (the R/B
                                            // quantization step in 565)
  for (int i = 0; i < 130; i++)
    irExpLUT[i] = expf(-(i * (IR_CUTOFF2 / 128.0f)) / IR_SIGMA2);
}

// Generates one rotation frame: gaussian blend of the points rotated
// around Y, vibrance, then edge vignette + highlights (fixed on screen)
// baked in. Colors go through the active AVATAR's transform (hue +
// saturation, see avatars.h): each badge has its own sphere.
static void irGenFrame(int fi)
{
  const float rotDeg = -IR_MAXROT + fi * (2 * IR_MAXROT / (IR_FRAMES - 1));
  const float theta = rotDeg * PI / 180.0f;
  const float cosT = cosf(theta), sinT = sinf(theta);
  const float satBoost = 1.75f, lumBoost = 1.12f;
  const float d2toLut = 128.0f / IR_CUTOFF2;
  const float rTex = IR_SPR * 229.0f / 466.0f; // ball radius in the frame (JS ratio)

  // palette colors transformed by the active avatar (or the custom buddy
  // configured via Setup, which takes precedence over the table)
  const AvatarDef &av = g_buddyCustom ? g_buddyCustomDef : AVATARS[g_avatarIdx];
  float PC[PAL_N][3];
  for (unsigned k = 0; k < PAL_N; k++)
  {
    if (av.hue != 0 || av.sat != 1.0f)
    {
      float h, s, l;
      rgb2hsl(PAL_RAINBOW[k][2], PAL_RAINBOW[k][3], PAL_RAINBOW[k][4], &h, &s, &l);
      h = fmodf(h + av.hue / 360.0f + 1.0f, 1.0f);
      s = constrain(s * av.sat, 0.0f, 1.0f);
      hsl2rgb(h, s, l, &PC[k][0], &PC[k][1], &PC[k][2]);
    }
    else
    {
      PC[k][0] = PAL_RAINBOW[k][2];
      PC[k][1] = PAL_RAINBOW[k][3];
      PC[k][2] = PAL_RAINBOW[k][4];
    }
  }

  // palette points rotated around the Y axis
  float rpx[PAL_N], rpy[PAL_N], rvis[PAL_N];
  for (unsigned k = 0; k < PAL_N; k++)
  {
    float nx = PAL_RAINBOW[k][0], ny = PAL_RAINBOW[k][1];
    float nzsq = 1 - nx * nx - ny * ny;
    float nz = nzsq > 0 ? sqrtf(nzsq) : 0;
    float nxr = nx * cosT + nz * sinT;
    float nzr = -nx * sinT + nz * cosT;
    rpx[k] = nxr;
    rpy[k] = ny;
    float vis = nzsq > 0 ? max(0.0f, nzr) : 0.5f;
    rvis[k] = sqrtf(vis);
  }

  uint8_t *dst = irFrames[fi];
  for (int y = 0; y < IR_SPR; y++)
    for (int x = 0; x < IR_SPR; x++)
    {
      float nx = (x - IR_SPR / 2.0f) / rTex, ny = (y - IR_SPR / 2.0f) / rTex;
      float pr = 0, pg = 0, pb = 0;
      if (nx * nx + ny * ny <= 1.0f)
      {
        float tw = 0;
        for (unsigned k = 0; k < PAL_N; k++)
        {
          float ddx = nx - rpx[k], ddy = ny - rpy[k];
          float d2 = ddx * ddx + ddy * ddy;
          if (d2 > IR_CUTOFF2)
            continue;
          float w = irExpLUT[(int)(d2 * d2toLut)] * rvis[k];
          tw += w;
          pr += PC[k][0] * w;
          pg += PC[k][1] * w;
          pb += PC[k][2] * w;
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
      // screen position of the texel (fixed) -> baked vignette + highlights
      float sx = -IR_SB + (x + 0.5f) * IR_DRAWN / IR_SPR;
      float sy = -IR_SB + (y + 0.5f) * IR_DRAWN / IR_SPR;
      float dxc = sx - CX, dyc = sy - CY;
      float rr = sqrtf(dxc * dxc + dyc * dyc) / RADIUS;
      // strong rimShade: rgba(12,7,20) 0 -> 0.22@0.60 -> 0.70@0.88 -> 1.0@1.0
      float a;
      if (rr < 0.60f)
        a = rr / 0.60f * 0.22f;
      else if (rr < 0.88f)
        a = 0.22f + (rr - 0.60f) / 0.28f * 0.48f;
      else
        a = min(1.0f, 0.70f + (rr - 0.88f) / 0.12f * 0.30f);
      pr = pr * (1 - a) + 12 * a;
      pg = pg * (1 - a) + 7 * a;
      pb = pb * (1 - a) + 20 * a;
      // main top-left highlight (golden white, additive)
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
      // secondary top-right highlight (soft pink, additive)
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
      px[0] = (uint8_t)max(0.0f, min(255.0f, pr));
      px[1] = (uint8_t)max(0.0f, min(255.0f, pg));
      px[2] = (uint8_t)max(0.0f, min(255.0f, pb));
    }
}

static void animIdleRainbow(float t)
{
  float lookX, lookY, openness;
  getIdle(t, &lookX, &lookY, &openness);

  // social encounter: the sphere follows the expression -- gaze smoothly
  // frozen (equivalent of the visualizer triggers' lookFreeze)
  lookX *= (1.0f - g_lookFreeze);
  lookY *= (1.0f - g_lookFreeze);

  // pick the 2 rotation frames + blend (like getSphereFramesBlended)
  float fidx = (lookX * IR_MAXROT + IR_MAXROT) / (2 * IR_MAXROT / (IR_FRAMES - 1));
  int lo = (int)fidx;
  if (lo < 0)
    lo = 0;
  if (lo > IR_FRAMES - 2)
    lo = IR_FRAMES - 2;
  // regeneration after an avatar/buddy change: the DISPLAYED frames
  // (lo, lo+1) are redone immediately -- otherwise the old sphere was
  // visible for an instant -- then one background frame per call for the
  // rest
  if (irDirtyMask)
  {
    irDirtyMask &= (1u << IR_FRAMES) - 1;
    bool shown = false;
    if (irDirtyMask & (1u << lo))
    {
      irGenFrame(lo);
      irDirtyMask &= ~(1u << lo);
      shown = true;
    }
    if (irDirtyMask & (1u << (lo + 1)))
    {
      irGenFrame(lo + 1);
      irDirtyMask &= ~(1u << (lo + 1));
      shown = true;
    }
    if (!shown)
      for (int i = 0; i < IR_FRAMES; i++)
        if (irDirtyMask & (1u << i))
        {
          irGenFrame(i);
          irDirtyMask &= ~(1u << i);
          break;
        }
  }

  int alpha16 = (int)((fidx - lo) * 16);
  const uint8_t *texA = irFrames[lo], *texB = irFrames[lo + 1];
  const uint8_t *tex;
  if (alpha16 <= 0)
    tex = texA;
  else if (alpha16 >= 16)
    tex = texB;
  else
  {
    // per-byte lerp, full 8-bit precision
    const int inv = 16 - alpha16;
    for (int i = 0; i < IR_SPR * IR_SPR * 3; i++)
      irScratch[i] = (uint8_t)((texA[i] * inv + texB[i] * alpha16) >> 4);
    tex = irScratch;
  }

  // bilinear upscale at half resolution (each sample fills a 2x2 block)
  // + subtle grain: ~2x faster, invisible on these soft gradients.
  // g_sphereYOff: vertical bounce of the sphere during a social reaction
  // (uncovered bands reset to black).
  // g_sphereScale: Love mode heartbeat -- sampling tables regenerated for
  // the frame (180 entries, negligible cost), pixels outside the texture
  // -> black (the sphere shrinks cleanly on a black background)
  const float ss = g_sphereScale;
  const bool scaled = ss < 0.999f || ss > 1.001f;
  static uint16_t sIdx[W / 2];
  static uint8_t sFrac[W / 2];
  static uint8_t sOut[W / 2];
  if (scaled)
    for (int i = 0; i < W / 2; i++)
    {
      float p = 180.0f + (2 * i + 0.5f - 180.0f) / ss;
      float tf = (p + IR_SB) * IR_SPR / IR_DRAWN - 0.5f;
      if (tf < 0 || tf > IR_SPR - 2)
      {
        sOut[i] = 1;
        sIdx[i] = 0;
        sFrac[i] = 0;
      }
      else
      {
        sOut[i] = 0;
        sIdx[i] = (uint16_t)tf;
        sFrac[i] = (uint8_t)((tf - (int)tf) * 16);
      }
    }
  const uint16_t *TIdx = scaled ? sIdx : irTIdx;
  const uint8_t *TFrac = scaled ? sFrac : irTFrac;
  uint16_t *fb = canvas->getFramebuffer();
  // 2 source rows cached in internal RAM, invalidated every frame (the
  // texture changes): interpolation reads from fast memory, PSRAM is
  // only read sequentially
  static uint8_t rowCache[2][IR_SPR * 3 + 4];
  int rowCached = -2;
  const int yOff = g_sphereYOff;
  if (yOff > 0)
    memset(fb, 0, (size_t)yOff * W * sizeof(uint16_t));
  else if (yOff < 0)
    memset(&fb[(H + yOff) * W], 0, (size_t)(-yOff) * W * sizeof(uint16_t));
  for (int y2 = 0; y2 < H / 2; y2++)
  {
    int dy = y2 * 2 + yOff;
    uint16_t *d0 = (dy >= 0 && dy < H) ? &fb[dy * W] : nullptr;
    uint16_t *d1 = (dy + 1 >= 0 && dy + 1 < H) ? &fb[(dy + 1) * W] : nullptr;
    if (!d0 && !d1)
      continue;
    if (scaled && sOut[y2]) // row outside the shrunken sphere -> black
    {
      if (d0)
        memset(d0, 0, W * sizeof(uint16_t));
      if (d1)
        memset(d1, 0, W * sizeof(uint16_t));
      continue;
    }
    int srcRow = TIdx[y2];
    if (srcRow != rowCached)
    {
      if (srcRow == rowCached + 1) // advanced one row: B becomes A
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
    int fy = TFrac[y2];
    for (int x2 = 0; x2 < W / 2; x2++)
    {
      if (scaled && sOut[x2]) // column outside the sphere -> black
      {
        int xx = x2 * 2;
        if (d0)
          d0[xx] = d0[xx + 1] = 0;
        if (d1)
          d1[xx] = d1[xx + 1] = 0;
        continue;
      }
      int tx3 = TIdx[x2] * 3, fx = TFrac[x2];
      const uint8_t *p00 = rowA + tx3, *p01 = rowB + tx3;
      int w11 = fx * fy, w10 = fx * (16 - fy), w01 = (16 - fx) * fy, w00 = (16 - fx) * (16 - fy);
      int r = (p00[0] * w00 + p00[3] * w10 + p01[0] * w01 + p01[3] * w11) >> 8;
      int g = (p00[1] * w00 + p00[4] * w10 + p01[1] * w01 + p01[4] * w11) >> 8;
      int b = (p00[2] * w00 + p00[5] * w10 + p01[2] * w01 + p01[5] * w11) >> 8;
      // 565 quantization with ordered dither (0..7): breaks gradient
      // banding without visible grain
      int d8 = irNoise[(x2 * 7 + y2 * 131) & 255];
      r += d8;
      g += d8 >> 1;
      b += irNoise[(x2 * 131 + y2 * 7 + 97) & 255];
      uint16_t c = (uint16_t)(((r > 255 ? 31 : r >> 3) << 11) |
                              ((g > 255 ? 63 : g >> 2) << 5) |
                              (b > 255 ? 31 : b >> 3));
      int xx = x2 * 2;
      if (d0)
      {
        d0[xx] = c;
        d0[xx + 1] = c;
      }
      if (d1)
      {
        d1[xx] = c;
        d1[xx + 1] = c;
      }
    }
  }

  drawIdleFaceLook(CX, CY + yOff, RADIUS * ss, t, lookX, lookY, openness);
}

