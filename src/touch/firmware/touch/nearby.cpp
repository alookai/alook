#include "nearby.h"
#include <BLERemoteService.h>
#include <BLERemoteCharacteristic.h>
#include <cstring>

namespace alook_touch {
namespace {
constexpr char service_uuid[] = "a1097090-81e8-4aaf-b8e0-3c41ada09be1";
constexpr char handle_uuid[] = "a1097091-81e8-4aaf-b8e0-3c41ada09be1";
bool valid_handle(const std::string& handle) {
  if (handle.size() < 6 || handle.size() > 160 || handle.find('\0') != std::string::npos) return false;
  const auto delimiter = handle.rfind('#');
  if (delimiter == std::string::npos || delimiter == 0 || handle.size() - delimiter != 5) return false;
  for (size_t i = delimiter + 1; i < handle.size(); ++i) if (handle[i] < '0' || handle[i] > '9') return false;
  for (char c : handle) if (static_cast<uint8_t>(c) < 32 || c == 127) return false;
  return true;
}
}
bool Nearby::start(const std::string& handle) {
  stop();
  if (!valid_handle(handle)) return false;
  if (!observations_) {
    observations_ = xQueueCreate(8, sizeof(Observation)); jobs_ = xQueueCreate(1, sizeof(ReadJob)); results_ = xQueueCreate(2, sizeof(ReadResult)); radio_ = xSemaphoreCreateMutex();
    if (!observations_ || !jobs_ || !results_ || !radio_) return false;
    BLEDevice::init(""); BLEDevice::setMTU(247);
    scan_ = BLEDevice::getScan(); scan_->setAdvertisedDeviceCallbacks(this, true); scan_->setActiveScan(false); scan_->setInterval(100); scan_->setWindow(35);
    auto* server = BLEDevice::createServer(); server_events_.owner = this; server->setCallbacks(&server_events_);
    auto* service = server->createService(service_uuid);
    characteristic_ = service->createCharacteristic(handle_uuid, BLECharacteristic::PROPERTY_READ);
    service->start();
    if (xTaskCreatePinnedToCore([](void* self) { static_cast<Nearby*>(self)->read_worker(); }, "touch-nearby", 8192, this, 1, nullptr, 0) != pdPASS) return false;
  }
  xSemaphoreTake(radio_, portMAX_DELAY);
  own_handle_ = handle; characteristic_->setValue(String(handle.c_str()));
  BLEAdvertisementData advertisement; advertisement.setFlags(0x06); advertisement.setCompleteServices(BLEUUID(service_uuid));
  const uint8_t marker[] = {0xff, 0xff, 'A', 'L', 1};
  advertisement.setManufacturerData(String(reinterpret_cast<const char*>(marker), sizeof(marker)));
  auto* advertising = BLEDevice::getAdvertising(); advertising->setScanResponse(false); advertising->setAdvertisementData(advertisement); advertising->setMinInterval(160); advertising->setMaxInterval(240);
  active_.store(true); advertise_again_.store(false); advertising->start();
  const bool started = scan_->start(0, [](BLEScanResults) {}, false);
  xSemaphoreGive(radio_);
  if (!started) stop();
  return started;
}
void Nearby::stop() {
  active_.store(false); generation_.fetch_add(1);
  if (radio_) {
    xSemaphoreTake(radio_, portMAX_DELAY);
    scan_->stop(); BLEDevice::getAdvertising()->stop(); scan_->clearResults(); characteristic_->setValue("");
    xSemaphoreGive(radio_);
  }
  own_handle_.clear(); peer_handle_.clear(); peer_address_.clear(); proximity_.reset(); attempted_at_ = 0;
  if (observations_) xQueueReset(observations_);
  if (results_) xQueueReset(results_);
}
void Nearby::onResult(BLEAdvertisedDevice device) {
  const uint32_t generation = generation_.load();
  if (!active_.load() || !device.haveManufacturerData() || !device.isAdvertisingService(BLEUUID(service_uuid))) return;
  const auto manufacturer = device.getManufacturerData();
  const uint8_t marker[] = {0xff, 0xff, 'A', 'L', 1};
  if (manufacturer.length() != sizeof(marker) || memcmp(manufacturer.c_str(), marker, sizeof(marker))) return;
  Observation value{}; const auto address = device.getAddress().toString();
  if (address.length() != 17) return;
  memcpy(value.address, address.c_str(), 17); value.type = device.getAddressType(); value.rssi = device.getRSSI(); value.time = millis(); value.generation = generation;
  if (!active_.load() || generation != generation_.load()) return;
  xQueueSend(observations_, &value, 0);
}
void Nearby::read_worker() {
  BLEClient* client = BLEDevice::createClient();
  for (;;) {
    ReadJob job{}; xQueueReceive(jobs_, &job, portMAX_DELAY);
    if (active_.load() && job.generation == generation_.load()) {
      xSemaphoreTake(radio_, portMAX_DELAY); scan_->stop(); xSemaphoreGive(radio_);
      if (active_.load() && job.generation == generation_.load() && client->connect(BLEAddress(String(job.address)), job.type, 3000)) {
        auto* service = client->getService(BLEUUID(service_uuid));
        auto* characteristic = service ? service->getCharacteristic(BLEUUID(handle_uuid)) : nullptr;
        if (characteristic && characteristic->canRead()) {
          const auto value = characteristic->readValue();
          const std::string handle(value.c_str(), value.length());
          if (valid_handle(handle) && active_.load() && job.generation == generation_.load()) {
            ReadResult result{}; memcpy(result.address, job.address, sizeof(job.address)); memcpy(result.handle, handle.data(), handle.size()); result.generation = job.generation;
            xQueueSend(results_, &result, 0);
          }
        }
        client->disconnect();
      }
      xSemaphoreTake(radio_, portMAX_DELAY);
      if (active_.load() && job.generation == generation_.load()) scan_->start(0, [](BLEScanResults) {}, false);
      xSemaphoreGive(radio_);
    }
    reading_.store(false);
  }
}
std::string Nearby::peer() {
  if (!active_.load()) return "";
  if (advertise_again_.exchange(false)) {
    xSemaphoreTake(radio_, portMAX_DELAY);
    if (active_.load()) BLEDevice::getAdvertising()->start();
    xSemaphoreGive(radio_);
  }
  Observation observation;
  while (xQueueReceive(observations_, &observation, 0) == pdPASS) if (observation.generation == generation_.load()) {
    proximity_.observe(observation.address, observation.rssi, observation.time); address_type_ = observation.type;
  }
  const auto address = proximity_.peer(millis());
  if (address != peer_address_) { peer_address_ = address; peer_handle_.clear(); attempted_at_ = 0; }
  ReadResult result;
  while (xQueueReceive(results_, &result, 0) == pdPASS) if (result.generation == generation_.load() && peer_address_ == result.address && own_handle_ != result.handle) peer_handle_ = result.handle;
  if (!peer_address_.empty() && !reading_.load() && (attempted_at_ == 0 || millis() - attempted_at_ >= 3000)) {
    ReadJob job{}; memcpy(job.address, peer_address_.c_str(), 17); job.type = address_type_; job.generation = generation_.load();
    reading_.store(true);
    if (xQueueSend(jobs_, &job, 0) != pdPASS) reading_.store(false);
    attempted_at_ = millis();
  }
  return peer_address_.empty() ? "" : peer_handle_;
}
}
