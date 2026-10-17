#pragma once
#include <string>

namespace alook_touch {
enum class UpdatePhase { Idle, Checking, Current, Available, CheckFailed, Installing, Restarting, InstallFailed };
struct UpdateData {
  UpdatePhase update_phase = UpdatePhase::Idle;
  std::string firmware_version;
  std::string available_version;
  std::string update_error;
  int update_progress = -1;
};
}
