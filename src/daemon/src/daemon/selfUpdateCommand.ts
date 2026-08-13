import type { HostCommand } from "../server/contract.js";
import { WS_CONTROL_COMMAND_CONSUMED } from "../server/wsControlChannel.js";

export function createSelfUpdateCommandListener(
  handleSelfUpdate?: () => void | Promise<void>,
) {
  return (command: HostCommand): void | typeof WS_CONTROL_COMMAND_CONSUMED => {
    if (command.type !== "machine:update") return;
    if (handleSelfUpdate) {
      try {
        Promise.resolve(handleSelfUpdate()).catch(() => { });
      } catch {
        // The lifecycle helper records its own scrubbed failure and remains retryable.
      }
    }
    return WS_CONTROL_COMMAND_CONSUMED;
  };
}
