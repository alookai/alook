#include "firmware_update.h"
#include "update_protocol.h"
#include "generated/build_info.h"
#include <esp_crt_bundle.h>
#include <esp_flash.h>
#include <esp_http_client.h>
#include <esp_https_ota.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#include <array>
#include <algorithm>
#include <cstring>

namespace alook_touch {
namespace {
struct Download { std::string body, location; bool overflow = false; };
bool trusted_url(const std::string& url) {
  for (const auto* prefix : {"https://api.github.com/", "https://github.com/", "https://release-assets.githubusercontent.com/", "https://objects.githubusercontent.com/"}) if (url.compare(0, strlen(prefix), prefix) == 0) return true;
  return false;
}
esp_err_t download_event(esp_http_client_event_t* event) {
  auto& result = *static_cast<Download*>(event->user_data);
  if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key && event->header_value && strcasecmp(event->header_key, "location") == 0) result.location = event->header_value;
  if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
    if (result.body.size() + event->data_len > 512 * 1024) { result.overflow = true; return ESP_FAIL; }
    result.body.append(static_cast<char*>(event->data), event->data_len);
  }
  return ESP_OK;
}
bool get_json(std::string url, std::string& body) {
  for (int redirects = 0; redirects <= 5; ++redirects) {
    if (!trusted_url(url)) return false;
    Download result;
    esp_http_client_config_t config{};
    config.url = url.c_str(); config.crt_bundle_attach = esp_crt_bundle_attach;
    config.timeout_ms = 15000; config.disable_auto_redirect = true;
    config.event_handler = download_event; config.user_data = &result;
    auto client = esp_http_client_init(&config);
    if (!client) return false;
    esp_http_client_set_header(client, "User-Agent", "AlookTouch-update");
    esp_http_client_set_header(client, "Accept", "application/vnd.github+json");
    const auto error = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (error != ESP_OK || result.overflow) return false;
    if (status == 200) { body = std::move(result.body); return true; }
    if (status < 300 || status >= 400 || result.location.empty()) return false;
    url = std::move(result.location);
  }
  return false;
}
bool compatible_partition(const esp_partition_t* target) {
  const auto* a = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr);
  const auto* b = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, nullptr);
  const auto* running = esp_ota_get_running_partition();
  uint32_t flash = 0;
  return esp_flash_get_size(nullptr, &flash) == ESP_OK && flash == 32 * 1024 * 1024 && a && b && running && target && target->address != running->address && a->address == 0x10000 && b->address == 0xc90000 && a->size == 0xc80000 && b->size == 0xc80000 && (running->address == a->address || running->address == b->address) && (target->address == a->address || target->address == b->address);
}
bool verify_partition(const esp_partition_t* partition, const FirmwareManifest& manifest) {
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  bool valid = mbedtls_sha256_starts(&context, 0) == 0;
  std::array<uint8_t, 4096> buffer;
  for (uint32_t offset = 0; valid && offset < manifest.bytes;) {
    const size_t length = std::min<size_t>(buffer.size(), manifest.bytes - offset);
    valid = esp_partition_read(partition, offset, buffer.data(), length) == ESP_OK && mbedtls_sha256_update(&context, buffer.data(), length) == 0;
    offset += length;
  }
  uint8_t digest[32];
  valid = valid && mbedtls_sha256_finish(&context, digest) == 0;
  mbedtls_sha256_free(&context);
  if (!valid) return false;
  char hex[65];
  for (size_t i = 0; i < sizeof(digest); ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  return manifest.sha256 == hex;
}
Response failure(const Request& request) { return {request.operation, request.owner, 503, "", request.target, request.id}; }
}

Response check_firmware(const Request& request, const std::atomic<uint32_t>& account) {
  PsramJsonAllocator allocator;
  for (int page = 1; page <= 20 && account.load() == request.owner.account; ++page) {
    std::string body;
    if (!get_json("https://api.github.com/repos/alookai/alook/releases?per_page=10&page=" + std::to_string(page), body)) return failure(request);
    JsonDocument releases(&allocator);
    if (deserializeJson(releases, body) || !releases.is<JsonArray>()) return failure(request);
    for (const auto release : releases.as<JsonArrayConst>()) {
      std::string tag;
      if (!touch_release(release, tag)) {
        if (has_touch_assets(release)) return failure(request);
        continue;
      }
      if (!get_json(release_base(tag) + "alook-touch-manifest.json", body)) return failure(request);
      JsonDocument document(&allocator);
      FirmwareManifest manifest;
      if (deserializeJson(document, body) || !read_manifest(document.as<JsonVariantConst>(), tag, hardware_id, partition_layout, manifest)) return failure(request);
      return {request.operation, request.owner, 200, std::move(body), tag, request.id};
    }
    if (releases.size() < 10) break;
  }
  return failure(request);
}

Response install_firmware(const Request& request, const std::atomic<uint32_t>& account, const std::function<void(int)>& progress) {
  JsonDocument document;
  FirmwareManifest manifest;
  std::array<uint32_t, 3> current, next;
  if (deserializeJson(document, request.body) || !read_manifest(document.as<JsonVariantConst>(), request.target, hardware_id, partition_layout, manifest) || !numeric_version(firmware_version, current) || !numeric_version(manifest.version, next) || next <= current) return failure(request);
  const auto* target = esp_ota_get_next_update_partition(nullptr);
  if (!compatible_partition(target)) return failure(request);
  const auto url = release_base(manifest.tag) + manifest.name;
  esp_http_client_config_t http{};
  http.url = url.c_str(); http.crt_bundle_attach = esp_crt_bundle_attach;
  http.timeout_ms = 20000; http.max_redirection_count = 5; http.buffer_size = 4096;
  esp_https_ota_config_t config{};
  config.http_config = &http; config.partition.staging = target;
  esp_https_ota_handle_t handle = nullptr;
  if (esp_https_ota_begin(&config, &handle) != ESP_OK) return failure(request);
  int last = -1;
  esp_err_t error;
  do {
    if (account.load() != request.owner.account) { esp_https_ota_abort(handle); return failure(request); }
    error = esp_https_ota_perform(handle);
    const int received = esp_https_ota_get_image_len_read(handle);
    if (received < 0 || static_cast<uint32_t>(received) > manifest.bytes) { esp_https_ota_abort(handle); return failure(request); }
    const int percent = static_cast<uint64_t>(received) * 100 / manifest.bytes;
    if (percent != last) { last = percent; progress(percent); }
  } while (error == ESP_ERR_HTTPS_OTA_IN_PROGRESS);
  if (error != ESP_OK || !esp_https_ota_is_complete_data_received(handle) || esp_https_ota_get_image_len_read(handle) != static_cast<int>(manifest.bytes) || !verify_partition(target, manifest) || account.load() != request.owner.account) {
    esp_https_ota_abort(handle); return failure(request);
  }
  if (esp_https_ota_finish(handle) != ESP_OK) return failure(request);
  return {request.operation, request.owner, 200, "{}", request.target, request.id};
}
}
