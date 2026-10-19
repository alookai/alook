#pragma once
#include "alook_network.h"
#include <functional>

namespace alook_touch {
Response check_firmware(const Request& request, const std::atomic<uint32_t>& account);
Response install_firmware(const Request& request, const std::atomic<uint32_t>& account, const std::function<void(int)>& progress);
}
