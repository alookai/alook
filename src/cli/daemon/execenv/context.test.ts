import { describe, it, expect } from "vitest";
import { buildInstructionContent } from "./context.js";
import type { Task } from "../types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    agentId: "agent-123",
    runtimeId: "r1",
    conversationId: "c1",
    workspaceId: "ws1",
    prompt: "test",
    status: "running",
    priority: 0,
    type: "user_dm_message",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildInstructionContent email tool injection", () => {
  it("includes email tool section with full email address when agent has email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("npx @alook/cli pull --agent_id agent-123 --status unread");
    expect(content).toContain("npx @alook/cli set --agent_id agent-123 --email_id <EMAIL_ID> --status read");
    expect(content).toContain("/tmp/alook-emails/");
    expect(content).toContain("metadata.json");
    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
  });

  it("includes send-email docs when agent has email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("npx @alook/cli email send --agent_id agent-123");
    expect(content).toContain("--body-file");
    expect(content).toContain("--attachment");
  });

  it("includes reply-to docs when agent has email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("--in-reply-to <EMAIL_ID>");
    expect(content).toContain("Replying to an email");
    expect(content).toContain("Re:");
  });

  it("omits send-email docs when agent has no email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff" },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("email send --agent_id");
  });

  it("includes owner email when user email is provided", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent", userEmail: "gus@example.com" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
    expect(content).toContain("Your owner's email address is 'gus@example.com'");
  });

  it("omits owner email line when user email is not provided", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
    expect(content).not.toContain("owner's email");
  });

  it("omits email tool section when agent has no email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff" },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("## Email Tools");
    expect(content).not.toContain("email pull");
  });

  it("omits email tool section when emailHandle is null", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: null },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("## Email Tools");
  });

  it("omits email tool section when emailHandle is empty string", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "" },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("## Email Tools");
  });

  it("uses correct agent ID in email tool commands", () => {
    const task = makeTask({
      agentId: "specific-agent-id",
      agent: { name: "test", instructions: "", emailHandle: "handle" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("--agent_id specific-agent-id");
  });

  it("still includes big boss instructions alongside email tools", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "Follow these rules", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("## BIG BOSS Instructions");
  });
});
