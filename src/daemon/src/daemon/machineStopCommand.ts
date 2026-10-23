import type { HostCommand } from "../server/contract.js";
import { WS_CONTROL_COMMAND_CONSUMED } from "../server/wsControlChannel.js";

export function createMachineStopCommandListener(onStopRequested?: () => void) {
  return (command: HostCommand): void | typeof WS_CONTROL_COMMAND_CONSUMED => {
    if (command.type !== "machine:stop") return;
    onStopRequested?.();
    return WS_CONTROL_COMMAND_CONSUMED;
  };
}
