#include "alook_network.h"
#include "configuration.h"
#include "firmware_update.h"
#include "socket_protocol.h"
#include <WiFi.h>
#include <esp_http_client.h>
#include <esp_crt_bundle.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>

extern const uint8_t certificate_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t certificate_bundle_end[] asm("_binary_x509_crt_bundle_end");

namespace alook_touch {
namespace {
constexpr size_t max_response_bytes = 512 * 1024;
struct HttpBody { std::string text; bool oversized = false; };
esp_err_t receive_http(esp_http_client_event_t* event) {
  auto* body = static_cast<HttpBody*>(event->user_data);
  if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
    if (body->text.size() + event->data_len > max_response_bytes) { body->oversized = true; return ESP_FAIL; }
    body->text.append(static_cast<char*>(event->data), event->data_len);
  }
  return ESP_OK;
}
}
void* PsramJsonAllocator::allocate(size_t size) { return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
void PsramJsonAllocator::deallocate(void* pointer) { heap_caps_free(pointer); }
void* PsramJsonAllocator::reallocate(void* pointer, size_t size) { return heap_caps_realloc(pointer, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }

bool Network::begin(const std::string& device_name) {
  device_name_ = device_name;
  requests_ = xQueueCreate(8, sizeof(Request*));
  responses_ = xQueueCreate(12, sizeof(Response*));
  if (!requests_ || !responses_) return false;
  return xTaskCreatePinnedToCore([](void* self) { static_cast<Network*>(self)->run(); }, "touch-network", 16384, this, 1, nullptr, 0) == pdPASS;
}
bool Network::submit(Request request) {
  auto* value = new Request(std::move(request));
  if (xQueueSend(requests_, &value, 0) == pdPASS) return true;
  delete value;
  return false;
}
std::unique_ptr<Response> Network::receive() {
  Response* value = nullptr;
  if (xQueueReceive(responses_, &value, 0) != pdPASS) return nullptr;
  return std::unique_ptr<Response>(value);
}
void Network::retire(uint32_t account) { account_.store(account); }
void Network::emit(Response response) {
  auto* value = new Response(std::move(response));
  while (xQueueSend(responses_, &value, pdMS_TO_TICKS(100)) != pdPASS) vTaskDelay(1);
}
Response Network::perform(const Request& request) {
  Response result{request.operation, request.owner, 0, "", request.target};
  result.id = request.id;
  if (WiFi.status() != WL_CONNECTED) return result;
  if (request.operation == Operation::UpdateCheck) return check_firmware(request, account_);
  if (request.operation == Operation::UpdateInstall) return install_firmware(request, account_, [this, &request](int percent) { emit({Operation::UpdateProgress, request.owner, percent, "", request.target, 0}); });
  const bool avatar = request.operation == Operation::AvatarBot || request.operation == Operation::AvatarHuman || request.operation == Operation::AvatarPeer;
  const bool absolute = request.path.compare(0, 8, "https://") == 0;
  const std::string url = avatar && absolute ? request.path : std::string(origin) + request.path;
  if (url.compare(0, 8, "https://") != 0 && !(ALOOK_TOUCH_ALLOW_HTTP && url.compare(0, 7, "http://") == 0)) return result;
  HttpBody body;
  esp_http_client_config_t configuration{};
  configuration.url = url.c_str();
  configuration.crt_bundle_attach = esp_crt_bundle_attach;
  configuration.timeout_ms = request.operation == Operation::Transcribe ? 60000 : 12000;
  configuration.event_handler = receive_http;
  configuration.user_data = &body;
  configuration.disable_auto_redirect = true;
  configuration.buffer_size = 4096;
  auto client = esp_http_client_init(&configuration);
  if (!client) return result;
  esp_http_client_set_header(client, "User-Agent", device_name_.c_str());
  esp_http_client_set_header(client, "Accept", avatar ? "image/*" : "application/json");
  esp_http_client_set_header(client, "X-Alook-Community-Contract", "3");
  std::string authorization;
  if (!request.token.empty() && (!absolute || url.compare(0, strlen(origin) + 1, std::string(origin) + "/") == 0)) { authorization = "Bearer " + request.token; esp_http_client_set_header(client, "Authorization", authorization.c_str()); }
  if (request.method == "POST") esp_http_client_set_method(client, HTTP_METHOD_POST);
  else if (request.method == "PUT") esp_http_client_set_method(client, HTTP_METHOD_PUT);
  else if (request.method == "DELETE") esp_http_client_set_method(client, HTTP_METHOD_DELETE);
  if (request.audio) {
    esp_http_client_set_header(client, "Content-Type", "audio/wav");
    esp_http_client_set_post_field(client, reinterpret_cast<const char*>(request.audio->data), request.audio->size);
  } else if (!request.body.empty()) {
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, request.body.data(), request.body.size());
  }
  const auto error = esp_http_client_perform(client);
  if (error == ESP_OK && !body.oversized) { result.status = esp_http_client_get_status_code(client); result.body = std::move(body.text); }
  esp_http_client_cleanup(client);
  return result;
}

void Network::socket_event(WStype_t type, uint8_t* payload, size_t length) {
  if (socket_owner_.account != account_.load()) return;
  if (type == WStype_CONNECTED) {
    JsonDocument auth;
    auth["type"] = "auth"; auth["token"] = socket_token_; auth["communityContract"] = socket_contract;
    String text; serializeJson(auth, text); socket_.sendTXT(text);
  } else if (type == WStype_DISCONNECTED) {
    socket_authenticated_ = false;
    emit({Operation::SocketClosed, socket_owner_, 0, "", ""});
  } else if (type == WStype_TEXT) {
    if (length <= 2048) {
      JsonDocument document;
      if (!deserializeJson(document, payload, length) && socket_auth_ok(document.as<JsonVariantConst>())) {
        socket_authenticated_ = true;
        emit({Operation::SocketReady, socket_owner_, 200, "", ""});
        return;
      }
    }
    if (socket_authenticated_) emit({Operation::SocketChanged, socket_owner_, 200, length <= 16384 ? std::string(reinterpret_cast<const char*>(payload), length) : "", ""});
  } else if (socket_authenticated_ && (type == WStype_FRAGMENT_TEXT_START || type == WStype_FRAGMENT_FIN)) {
    emit({Operation::SocketChanged, socket_owner_, 200, "", ""});
  }
}

void Network::run() {
  socket_.onEvent([this](WStype_t type, uint8_t* payload, size_t length) { socket_event(type, payload, length); });
  socket_.setReconnectInterval(3000);
  socket_.enableHeartbeat(20000, 5000, 2);
  for (;;) {
    if (socket_started_ && socket_owner_.account != account_.load()) {
      socket_started_ = false; socket_authenticated_ = false; socket_.disconnect(); socket_token_.clear();
    }
    Request* next = nullptr;
    if (xQueueReceive(requests_, &next, 0) == pdPASS) {
      std::unique_ptr<Request> request(next);
      if (request->owner.account == account_.load() || request->operation == Operation::Logout) {
        if (request->operation == Operation::SocketStop) {
          socket_started_ = false; socket_authenticated_ = false; socket_.disconnect(); socket_token_.clear();
        } else if (request->operation == Operation::SocketStart) {
          socket_.disconnect(); socket_owner_ = request->owner; socket_token_ = request->token; socket_authenticated_ = false;
          std::string host(origin); const bool secure = host.compare(0, 8, "https://") == 0;
          host.erase(0, secure ? 8 : 7);
          unsigned port = secure ? 443 : 80;
          const auto colon = host.find(':');
          if (colon != std::string::npos) { port = std::strtoul(host.c_str() + colon + 1, nullptr, 10); host.resize(colon); }
          const std::string path = "/api/ws/user?userId=" + request->target;
          if (secure) socket_.beginSslWithBundle(host.c_str(), port, path.c_str(), certificate_bundle_start, certificate_bundle_end - certificate_bundle_start, "");
          else if (ALOOK_TOUCH_ALLOW_HTTP) socket_.begin(host.c_str(), port, path.c_str(), "");
          socket_started_ = secure || ALOOK_TOUCH_ALLOW_HTTP;
        } else emit(perform(*request));
      }
    }
    if (socket_started_ && WiFi.status() == WL_CONNECTED) socket_.loop();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
}
