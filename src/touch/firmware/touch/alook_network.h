#pragma once
#include "ownership.h"
#include "audio.h"
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <atomic>
#include <memory>
#include <string>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

namespace alook_touch {
enum class Operation { Authorize, PollAuthorization, Profile, Dms, DmProfile, Presence, OpenDm, History, Older, Send, Read, Transcribe, LookupPeer, PeerProfile, FriendsPending, FriendsAccepted, Friend, AcceptFriend, RequestList, AcceptRequest, UpdateCheck, UpdateInstall, UpdateProgress, Logout, AvatarBot, AvatarHuman, AvatarPeer, SocketStart, SocketStop, SocketReady, SocketChanged, SocketClosed };
struct Request {
  Operation operation;
  Owner owner{};
  std::string method = "GET";
  std::string path;
  std::string body;
  std::string token;
  std::string target;
  std::shared_ptr<AudioClip> audio;
  uint32_t id = 0;
};
struct Response {
  Operation operation;
  Owner owner{};
  int status = 0;
  std::string body;
  std::string target;
  uint32_t id = 0;
};
class Network {
public:
  bool begin(const std::string& device_name);
  bool submit(Request request);
  std::unique_ptr<Response> receive();
  void retire(uint32_t account);
private:
  QueueHandle_t requests_ = nullptr;
  QueueHandle_t responses_ = nullptr;
  std::atomic<uint32_t> account_{1};
  WebSocketsClient socket_;
  Owner socket_owner_{};
  std::string socket_token_;
  std::string device_name_;
  bool socket_started_ = false;
  bool socket_authenticated_ = false;
  void run();
  void emit(Response response);
  void socket_event(WStype_t type, uint8_t* payload, size_t length);
  Response perform(const Request& request);
};

struct PsramJsonAllocator : ArduinoJson::Allocator {
  void* allocate(size_t size) override;
  void deallocate(void* pointer) override;
  void* reallocate(void* pointer, size_t size) override;
};
}
