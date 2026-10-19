/* SPDX-License-Identifier: MIT
Adapted from Speaker firmware-badge; see third_party/NOTICE.md. */
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace alook_touch {
class SpeakerIdle {
public:
  struct Pose { float x; float y; float eyes; };
  Pose at(float time) {
    if (time < last_time_) reset();
    last_time_ = time;
    if (time >= hold_) {
      px_ = x_; py_ = y_;
      const float r = random(0, 1);
      if (r < 0.30f) { x_ = random(-0.15f, 0.15f); y_ = random(-0.15f, 0.15f); }
      else if (r < 0.50f) { x_ = -(0.5f + random(0, 0.5f)); y_ = random(-0.2f, 0.2f); }
      else if (r < 0.70f) { x_ = 0.5f + random(0, 0.5f); y_ = random(-0.2f, 0.2f); }
      else { x_ = random(-0.7f, 0.7f); y_ = random(-0.5f, 0.5f); }
      start_ = time;
      duration_ = 0.4f + random(0, 0.5f);
      hold_ = time + duration_ + 0.8f + random(0, 2.2f);
    }
    const float t = std::clamp((time - start_) / duration_, 0.0f, 1.0f);
    const float e = t < 0.5f ? 4 * t * t * t : 1 - std::pow(-2 * t + 2, 3) / 2;
    Pose pose{
      std::clamp(px_ + (x_ - px_) * e + std::sin(time * 1.4f) * 0.04f + std::sin(time * 0.7f + 1.3f) * 0.025f, -1.0f, 1.0f),
      std::clamp(py_ + (y_ - py_) * e + std::sin(time * 1.1f + 0.4f) * 0.03f + std::sin(time * 0.5f + 2.1f) * 0.02f, -1.0f, 1.0f),
      1,
    };
    if (blink_start_ < 0 && time >= next_blink_) { blink_start_ = time; blink_duration_ = 0.14f + random(0, 0.10f); }
    if (blink_start_ >= 0) {
      const float t = (time - blink_start_) / blink_duration_;
      if (t >= 1 || t < 0) { blink_start_ = -1; next_blink_ = time + (random(0, 1) < 0.25f ? 0.15f : 1.8f + random(0, 3.5f)); }
      else pose.eyes = t < 0.4f ? 1 - t / 0.4f : (t - 0.4f) / 0.6f;
    }
    return pose;
  }
  void reset() { x_ = y_ = px_ = py_ = start_ = last_time_ = 0; duration_ = hold_ = 0.5f; blink_start_ = -1; next_blink_ = 2.5f; }
private:
  uint32_t noise_ = 0x937AD251u;
  float x_ = 0, y_ = 0, px_ = 0, py_ = 0, start_ = 0, duration_ = 0.5f, hold_ = 0.5f;
  float blink_start_ = -1, blink_duration_ = 0.2f, next_blink_ = 2.5f, last_time_ = 0;
  float random(float lo, float hi) { noise_ ^= noise_ << 13; noise_ ^= noise_ >> 17; noise_ ^= noise_ << 5; return lo + (hi - lo) * (noise_ / 4294967296.0f); }
};

struct SphereFeature { float x; float y; float width; };
inline SphereFeature sphere_feature(float x, float y, float look_x, float look_y, float time, float radius) {
  const float nx = (x - radius) / radius, ny = (y - radius) / radius;
  const float nz = std::sqrt(std::max(0.0f, 1 - nx * nx - ny * ny));
  const float theta = look_x * 3.14159265358979323846f / 6;
  const float cosine = std::cos(theta), sine = std::sin(theta);
  const float breathe = std::sin(time * 1.8f) * .5f;
  return {radius + (nx * cosine + nz * sine) * radius + breathe * .6f,
    y + breathe * .4f + look_y * radius * .18f, std::max(.3f, -nx * sine + nz * cosine)};
}

struct SpeakerBubble { float x, y, vx, vy, radius; };
class SpeakerMenu {
public:
  std::array<SpeakerBubble, 3> bubbles{};
  int focused = 0;
  SpeakerMenu() { reset(); }
  void reset() { for (size_t i = 0; i < bubbles.size(); ++i) bubbles[i] = {anchors[i][0], anchors[i][1], 0, 0, radii[i] * (static_cast<int>(i) == focused ? 1.26f : 0.80f)}; }
  void step(float dt) {
    if (!std::isfinite(dt) || dt <= 0) return;
    if (dt > 0.25f) dt = 0.05f;
    while (dt > 0.0001f) {
      const float h = std::min(dt, 0.016f); dt -= h;
      for (size_t i = 0; i < bubbles.size(); ++i) {
        auto& b = bubbles[i];
        b.radius += (radii[i] * (static_cast<int>(i) == focused ? 1.26f : 0.80f) - b.radius) * (1 - std::exp(-h * 10));
        float hx = anchors[i][0], hy = std::max(anchors[i][1], 82 + b.radius);
        const float dx = hx - 180, dy = hy - 180, distance = std::hypot(dx, dy), bound = 176 - b.radius;
        if (distance > bound && distance > 1) { hx = 180 + dx / distance * bound; hy = 180 + dy / distance * bound; }
        b.vx += (hx - b.x) * 26 * h; b.vy += (hy - b.y) * 26 * h;
      }
      for (size_t a = 0; a < bubbles.size(); ++a) for (size_t b = a + 1; b < bubbles.size(); ++b) {
        auto& left = bubbles[a]; auto& right = bubbles[b];
        const float dx = right.x - left.x, dy = right.y - left.y, d2 = dx * dx + dy * dy, minimum = left.radius + right.radius + 8;
        if (d2 < minimum * minimum && d2 > 1) {
          const float distance = std::sqrt(d2), overlap = minimum - distance, nx = dx / distance, ny = dy / distance;
          left.x -= nx * overlap * 0.25f; left.y -= ny * overlap * 0.25f;
          right.x += nx * overlap * 0.25f; right.y += ny * overlap * 0.25f;
          left.vx -= nx * overlap * 4; left.vy -= ny * overlap * 4;
          right.vx += nx * overlap * 4; right.vy += ny * overlap * 4;
        }
      }
      for (auto& b : bubbles) {
        const float damping = std::exp(-h * 4);
        b.vx *= damping; b.vy *= damping; b.x += b.vx * h; b.y += b.vy * h;
        const float dx = b.x - 180, dy = b.y - 180, distance = std::hypot(dx, dy), bound = 176 - b.radius;
        if (distance > bound && distance > 1) {
          b.x = 180 + dx / distance * bound; b.y = 180 + dy / distance * bound;
          const float dot = (b.vx * dx + b.vy * dy) / distance;
          if (dot > 0) { b.vx -= dx / distance * dot; b.vy -= dy / distance * dot; }
        }
        if (b.y - b.radius < 82) { b.y = 82 + b.radius; if (b.vy < 0) b.vy = 0; }
      }
    }
  }
private:
  static constexpr float anchors[3][2] = {{116, 184}, {246, 146}, {246, 268}};
  static constexpr float radii[3] = {72, 76, 66};
};
}
