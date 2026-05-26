import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApplyEmailTriageResult = vi.fn();
const mockParseEmailTriageOutput = vi.fn();
const mockWarn = vi.fn();

vi.mock("@alook/shared", () => ({
  TASK_TYPES: {
    EMAIL_TRIAGE: "email_triage",
  },
}));

vi.mock("@/lib/services/email-triage", () => ({
  applyEmailTriageResult: (...args: unknown[]) => mockApplyEmailTriageResult(...args),
  parseEmailTriageOutput: (...args: unknown[]) => mockParseEmailTriageOutput(...args),
}));

vi.mock("@/lib/logger", () => ({
  log: {
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

import { handleTaskTerminalSideEffects } from "./task-terminal-handlers";

describe("email triage task terminal side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseEmailTriageOutput.mockReturnValue({ ok: false });
    mockApplyEmailTriageResult.mockResolvedValue({ applied: false });
  });

  it("handles completed email_triage tasks by applying parsed triage output", async () => {
    mockParseEmailTriageOutput.mockReturnValue({ ok: true, decision: "untrust" });
    mockApplyEmailTriageResult.mockResolvedValue({ applied: true, decision: "untrust" });

    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "{\"decision\":\"untrust\"}" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: { inboundEmailId: "e1" },
      },
    });

    expect(handled).toEqual({ handled: true });
    expect(mockParseEmailTriageOutput).toHaveBeenCalledWith("{\"decision\":\"untrust\"}");
    expect(mockApplyEmailTriageResult).toHaveBeenCalledWith(
      {},
      "w1",
      "a1",
      "e1",
      { ok: true, decision: "untrust" },
    );
  });

  it("logs cleanupError returned by email triage apply result", async () => {
    mockParseEmailTriageOutput.mockReturnValue({
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hi", htmlBody: "<p>Hi</p>" },
    });
    mockApplyEmailTriageResult.mockResolvedValue({
      applied: false,
      cleanupError: "cleanup failed",
    });

    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "{\"decision\":\"draft_reply\",\"draft\":{\"subject\":\"Re: Hi\",\"htmlBody\":\"<p>Hi</p>\"}}" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: { inboundEmailId: "e1" },
      },
    });

    expect(handled).toEqual({ handled: true, error: "email triage apply failed: cleanup failed" });
    expect(mockWarn).toHaveBeenCalledWith(
      "email triage cleanup failed",
      expect.objectContaining({
        taskId: "t1",
        inboundEmailId: "e1",
        cleanupError: "cleanup failed",
      }),
    );
  });

  it("handles failed email_triage tasks without applying triage output", async () => {
    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "failed",
      parsedResult: { output: "{\"decision\":\"untrust\"}" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: { inboundEmailId: "e1" },
      },
    });

    expect(handled).toEqual({ handled: true });
    expect(mockParseEmailTriageOutput).not.toHaveBeenCalled();
    expect(mockApplyEmailTriageResult).not.toHaveBeenCalled();
  });

  it("does not handle ordinary task types", async () => {
    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "hello" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "user_dm_message",
        context: null,
      },
    });

    expect(handled).toEqual({ handled: false });
    expect(mockApplyEmailTriageResult).not.toHaveBeenCalled();
  });

  it("returns visible error for invalid triage output", async () => {
    mockParseEmailTriageOutput.mockReturnValue({ ok: false });

    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "not-json" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: { inboundEmailId: "e1" },
      },
    });

    expect(handled).toEqual({ handled: true, error: "invalid email triage output" });
    expect(mockApplyEmailTriageResult).not.toHaveBeenCalled();
  });

  it("returns visible error when inboundEmailId is missing", async () => {
    mockParseEmailTriageOutput.mockReturnValue({ ok: true, decision: "untrust" });

    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "{\"decision\":\"untrust\"}" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: {},
      },
    });

    expect(handled).toEqual({ handled: true, error: "email triage missing inboundEmailId" });
    expect(mockApplyEmailTriageResult).not.toHaveBeenCalled();
  });

  it("returns visible error when triage apply fails without cleanup error", async () => {
    mockParseEmailTriageOutput.mockReturnValue({ ok: true, decision: "untrust" });
    mockApplyEmailTriageResult.mockResolvedValue({ applied: false });

    const handled = await handleTaskTerminalSideEffects({
      db: {},
      workspaceId: "w1",
      terminalState: "completed",
      parsedResult: { output: "{\"decision\":\"untrust\"}" },
      task: {
        id: "t1",
        agentId: "a1",
        workspaceId: "w1",
        conversationId: "c1",
        type: "email_triage",
        context: { inboundEmailId: "e1" },
      },
    });

    expect(handled).toEqual({ handled: true, error: "email triage apply failed" });
  });
});
