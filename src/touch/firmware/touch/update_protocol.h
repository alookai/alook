#pragma once
#include <ArduinoJson.h>
#include "update_state.h"
#include <array>
#include <cctype>
#include <string>

namespace alook_touch {
struct FirmwareManifest {
  std::string version, tag, source, hardware, layout, name, sha256;
  uint32_t bytes = 0;
};
inline bool numeric_version(const std::string& text, std::array<uint32_t, 3>& parts) {
  size_t index = 0;
  for (size_t part = 0; part < 3; ++part) {
    const auto start = index;
    uint32_t value = 0;
    while (index < text.size() && text[index] >= '0' && text[index] <= '9') {
      if (index - start >= 8) return false;
      value = value * 10 + text[index++] - '0';
    }
    if (index == start || (index - start > 1 && text[start] == '0')) return false;
    parts[part] = value;
    if (part < 2 && (index >= text.size() || text[index++] != '.')) return false;
  }
  return index == text.size();
}
inline bool hex_digest(const std::string& text, size_t length) {
  if (text.size() != length) return false;
  for (const auto c : text) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}
inline std::string release_base(const std::string& tag) { return "https://github.com/alookai/alook/releases/download/" + tag + "/"; }
inline bool has_touch_assets(JsonVariantConst value) {
  if (value["draft"] == true || value["prerelease"] == true) return false;
  for (const auto asset : value["assets"].as<JsonArrayConst>()) {
    const std::string name = asset["name"] | "";
    if (name == "alook-touch-manifest.json" || (name.compare(0, 12, "alook-touch-") == 0 && name.size() > 16 && name.compare(name.size() - 4, 4, ".bin") == 0)) return true;
  }
  return false;
}
inline bool read_manifest(JsonVariantConst value, const std::string& tag, const std::string& hardware, const std::string& layout, FirmwareManifest& out) {
  FirmwareManifest next;
  next.version = value["version"] | ""; next.tag = value["tag"] | "";
  next.source = value["sourceCommit"] | ""; next.hardware = value["hardware"] | "";
  next.layout = value["partitionLayout"] | ""; next.name = value["binary"]["name"] | "";
  next.sha256 = value["binary"]["sha256"] | "";
  if (!value["binary"]["bytes"].is<uint32_t>()) return false;
  next.bytes = value["binary"]["bytes"].as<uint32_t>();
  std::array<uint32_t, 3> version;
  if (value["schemaVersion"] != 1 || value["component"] != "touch" || !numeric_version(next.version, version) || next.tag != tag || next.tag != "v" + next.version || next.hardware != hardware || next.layout != layout || !hex_digest(next.source, 40) || !hex_digest(next.sha256, 64) || next.bytes == 0 || next.bytes > 0xc80000 || next.name != "alook-touch-" + next.version + ".bin") return false;
  out = std::move(next);
  return true;
}
inline bool touch_release(JsonVariantConst value, std::string& tag) {
  if (!value["draft"].is<bool>() || !value["prerelease"].is<bool>() || value["draft"] == true || value["prerelease"] == true || !value["assets"].is<JsonArrayConst>()) return false;
  const std::string candidate = value["tag_name"] | "";
  std::array<uint32_t, 3> version;
  if (candidate.empty() || candidate[0] != 'v' || !numeric_version(candidate.substr(1), version)) return false;
  bool manifest = false, binary = false;
  for (const auto asset : value["assets"].as<JsonArrayConst>()) {
    const std::string name = asset["name"] | "";
    if (asset["state"] != "uploaded" || asset["browser_download_url"] != release_base(candidate) + name) continue;
    manifest = manifest || name == "alook-touch-manifest.json";
    binary = binary || name == "alook-touch-" + candidate.substr(1) + ".bin";
  }
  if (!manifest || !binary) return false;
  tag = candidate;
  return true;
}
inline bool finish_update_check(UpdateData& data, bool response_ok, JsonVariantConst value, const std::string& tag, const std::string& current_version, const std::string& hardware, const std::string& layout) {
  FirmwareManifest manifest;
  std::array<uint32_t, 3> current, next;
  data.available_version.clear(); data.update_error.clear();
  if (!response_ok || !read_manifest(value, tag, hardware, layout, manifest) || !numeric_version(current_version, current) || !numeric_version(manifest.version, next)) {
    data.update_phase = UpdatePhase::CheckFailed;
    data.update_error = "Could not check compatible firmware. Try again.";
    return false;
  }
  data.update_phase = next > current ? UpdatePhase::Available : UpdatePhase::Current;
  if (data.update_phase == UpdatePhase::Available) data.available_version = manifest.version;
  return true;
}
}
