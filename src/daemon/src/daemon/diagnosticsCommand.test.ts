import { describe, expect, it, vi } from "vitest";
import { WS_CONTROL_COMMAND_CONSUMED } from "../server/wsControlChannel";
import { createDiagnosticsCommandListener } from "./diagnosticsCommand";

const command = {
  type: "diagnostics:collect" as const,
  reportId: "dbr_0123456789abcdef",
  agentId: "bot_1",
  fromMs: 1_700_000_000_000,
  deadlineAt: 1_700_087_000_000,
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("diagnostics-only daemon command consumer", () => {
  it("claims diagnostics synchronously and completes through the injected handler", async () => {
    const handleDiagnosticCommand = vi.fn(async () => {});
    const reportDiagnosticFailure = vi.fn(async () => {});
    const listener = createDiagnosticsCommandListener({
      handleDiagnosticCommand,
      reportDiagnosticFailure,
    });

    const result = listener(command);

    expect(result).toBe(WS_CONTROL_COMMAND_CONSUMED);
    await settle();
    expect(handleDiagnosticCommand).toHaveBeenCalledOnce();
    expect(handleDiagnosticCommand).toHaveBeenCalledWith(command);
    expect(reportDiagnosticFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["sync throw", vi.fn(() => { throw new Error("private sync detail"); })],
    ["async reject", vi.fn(async () => { throw new Error("private async detail"); })],
  ])("claims before returning and reports %s handler failure exactly once", async (_label, handler) => {
    const reportDiagnosticFailure = vi.fn(async () => {});
    const listener = createDiagnosticsCommandListener({
      handleDiagnosticCommand: handler,
      reportDiagnosticFailure,
    });

    const result = listener(command);

    expect(result).toBe(WS_CONTROL_COMMAND_CONSUMED);
    await settle();
    expect(reportDiagnosticFailure).toHaveBeenCalledOnce();
    expect(reportDiagnosticFailure).toHaveBeenCalledWith({
      reportId: command.reportId,
      failureCode: "diagnostics_unavailable",
    });
    expect(JSON.stringify(reportDiagnosticFailure.mock.calls)).not.toMatch(/private|detail/);
  });

  it("does not claim any non-diagnostics HostCommand", () => {
    const reportDiagnosticFailure = vi.fn();
    const listener = createDiagnosticsCommandListener({ reportDiagnosticFailure });

    expect(listener({ type: "agent:stop", agentId: "bot_1" })).toBeUndefined();
    expect(reportDiagnosticFailure).not.toHaveBeenCalled();
  });
});
