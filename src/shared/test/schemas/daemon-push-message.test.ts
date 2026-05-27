import { describe, it, expect } from "vitest";
import { DaemonPushMessageSchema } from "../../src/schemas";

describe("DaemonPushMessageSchema — daemon.kill", () => {
  it("accepts valid daemon.kill message with agentId", () => {
    const msg = {
      type: "daemon.kill",
      workspaceId: "ws1",
      agentId: "ag_abc123",
      taskId: "kt1",
      targetTaskId: "t1",
    };
    const result = DaemonPushMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("rejects daemon.kill message without agentId", () => {
    const msg = {
      type: "daemon.kill",
      workspaceId: "ws1",
      taskId: "kt1",
      targetTaskId: "t1",
    };
    const result = DaemonPushMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects daemon.kill message with non-string agentId", () => {
    const msg = {
      type: "daemon.kill",
      workspaceId: "ws1",
      agentId: 123,
      taskId: "kt1",
      targetTaskId: "t1",
    };
    const result = DaemonPushMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects daemon.kill message with empty string agentId", () => {
    const msg = {
      type: "daemon.kill",
      workspaceId: "ws1",
      agentId: "",
      taskId: "kt1",
      targetTaskId: "t1",
    };
    const result = DaemonPushMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});
