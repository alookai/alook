import type { DiagnosticCollectCommand } from "@alook/shared";
import type { HostCommand } from "../server/contract.js";
import { WS_CONTROL_COMMAND_CONSUMED } from "../server/wsControlChannel.js";

export type DiagnosticFailureReport = Readonly<{
  reportId: string;
  failureCode: "diagnostics_unavailable";
}>;

export type DiagnosticsCommandListenerOptions = Readonly<{
  handleDiagnosticCommand?: (
    command: DiagnosticCollectCommand,
  ) => void | Promise<void>;
  reportDiagnosticFailure?: (
    failure: DiagnosticFailureReport,
  ) => void | Promise<void>;
}>;

function reportUnavailable(
  options: DiagnosticsCommandListenerOptions,
  reportId: string,
): void {
  if (!options.reportDiagnosticFailure) return;
  try {
    Promise.resolve(options.reportDiagnosticFailure({
      reportId,
      failureCode: "diagnostics_unavailable",
    })).catch(() => { });
  } catch {
    // Reporting is best-effort and must never re-enter the WS dispatcher.
  }
}

export function createDiagnosticsCommandListener(
  options: DiagnosticsCommandListenerOptions,
) {
  return (command: HostCommand): void | typeof WS_CONTROL_COMMAND_CONSUMED => {
    if (command.type !== "diagnostics:collect") return;

    const handler = options.handleDiagnosticCommand;
    if (!handler) {
      reportUnavailable(options, command.reportId);
      return WS_CONTROL_COMMAND_CONSUMED;
    }

    try {
      Promise.resolve(handler(command)).catch(() => {
        reportUnavailable(options, command.reportId);
      });
    } catch {
      reportUnavailable(options, command.reportId);
    }
    return WS_CONTROL_COMMAND_CONSUMED;
  };
}
