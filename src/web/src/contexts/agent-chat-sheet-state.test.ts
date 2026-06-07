import { describe, expect, it } from "vitest";
import {
  capturePreviousMainTargetForBranch,
  normalizeSheetTarget,
  type AgentChatSheetTarget,
} from "./agent-chat-sheet-state";

const mainTarget: AgentChatSheetTarget = {
  agentId: "agent_main",
  conversationId: "conv_main",
  taskId: "task_1",
  messageId: "msg_1",
};

describe("normalizeSheetTarget", () => {
  it("normalizes omitted optional fields to null", () => {
    expect(normalizeSheetTarget("agent_main")).toEqual({
      agentId: "agent_main",
      conversationId: null,
      taskId: null,
      messageId: null,
    });
  });
});

describe("capturePreviousMainTargetForBranch", () => {
  it("captures the current main sheet target for branch return", () => {
    expect(
      capturePreviousMainTargetForBranch({
        isOpen: true,
        currentMode: "main",
        currentTarget: mainTarget,
      }),
    ).toEqual(mainTarget);
  });

  it("uses the explicit return target when the current sheet target has no conversation id", () => {
    const explicitReturnTarget = {
      agentId: "agent_main",
      conversationId: "conv_resolved",
      taskId: null,
      messageId: null,
    };

    expect(
      capturePreviousMainTargetForBranch({
        isOpen: true,
        currentMode: "main",
        currentTarget: {
          agentId: "agent_main",
          conversationId: null,
          taskId: null,
          messageId: null,
        },
        explicitReturnTarget,
      }),
    ).toEqual(explicitReturnTarget);
  });

  it("does not capture when no sheet is open", () => {
    expect(
      capturePreviousMainTargetForBranch({
        isOpen: false,
        currentMode: "main",
        currentTarget: mainTarget,
        explicitReturnTarget: mainTarget,
      }),
    ).toBeNull();
  });

  it("does not capture when the current sheet is already a branch", () => {
    expect(
      capturePreviousMainTargetForBranch({
        isOpen: true,
        currentMode: "branch",
        currentTarget: mainTarget,
      }),
    ).toBeNull();
  });

  it("does not expose a return target when the main sheet cannot be restored exactly", () => {
    expect(
      capturePreviousMainTargetForBranch({
        isOpen: true,
        currentMode: "main",
        currentTarget: {
          agentId: "agent_main",
          conversationId: null,
          taskId: null,
          messageId: null,
        },
      }),
    ).toBeNull();
  });
});
