#pragma once
#include "proximity.h"
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEServer.h>
#include <BLEClient.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

namespace alook_touch {
class Nearby : private BLEAdvertisedDeviceCallbacks {
public:
  bool start(const std::string& handle);
  void stop();
  bool release();
  std::string peer();
  bool active() const { return active_.load(); }
private:
  struct Observation { char address[18]; uint8_t type; int rssi; uint32_t time; uint32_t generation; };
  struct ReadJob { char address[18]; uint8_t type; uint32_t generation; };
  struct ReadResult { char address[18]; char handle[161]; uint32_t generation; };
  struct ServerEvents : BLEServerCallbacks {
    Nearby* owner = nullptr;
    void onDisconnect(BLEServer*) override { owner->advertise_again_.store(true); }
  } server_events_;
  QueueHandle_t observations_ = nullptr;
  QueueHandle_t jobs_ = nullptr;
  QueueHandle_t results_ = nullptr;
  SemaphoreHandle_t radio_ = nullptr;
  std::atomic<bool> active_{false};
  std::atomic<bool> reading_{false};
  std::atomic<bool> advertise_again_{false};
  std::atomic<bool> releasing_{false}, worker_done_{true};
  bool owns_radio_ = false;
  std::atomic<uint32_t> generation_{0};
  BLEScan* scan_ = nullptr;
  BLECharacteristic* characteristic_ = nullptr;
  Proximity proximity_;
  std::string own_handle_, peer_handle_, peer_address_;
  uint32_t attempted_at_ = 0;
  uint8_t address_type_ = 0;
  void onResult(BLEAdvertisedDevice device) override;
  void read_worker();
};
}
