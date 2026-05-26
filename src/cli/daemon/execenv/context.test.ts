import { describe, it, expect } from "vitest";
import { buildInstructionContent, resolveInstruction } from "./context.js";
import { tempDir } from "../../lib/platform.js";
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

    expect(content).toContain("npx @alook/cli email pull --status unread");
    expect(content).toContain("npx @alook/cli email set --email_id <EMAIL_ID> --status read");
    expect(content).not.toContain("email pull --agent_id");
    expect(content).not.toContain("email set --agent_id");
    expect(content).toContain(`${tempDir("alook-emails")}/ws1/agent-123/`);
    expect(content).toContain("metadata.json");
    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
  });

  it("includes --email_id pull instruction for ID-based fetching", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("email pull --email_id <EMAIL_ID>");
    expect(content).toContain("fetch ONLY that specific email");
    expect(content).toContain("no `email_id` is present");
  });

  it("includes send-email docs when agent has email handle", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("npx @alook/cli email send --to");
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

    expect(content).not.toContain("email send --to");
  });

  it("includes owner email in opening line when user email is provided", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent", userEmail: "gus@example.com" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
    expect(content).toContain("Your owner and creator is (gus@example.com).");
  });

  it("omits owner sentence when user email is not provided", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "do stuff", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("'myagent@alook.ai' (default, Alook platform address)");
    expect(content).not.toContain("owner and creator");
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

  it("does not include --agent_id in CLI examples and shows auto-detect note", () => {
    const task = makeTask({
      agentId: "specific-agent-id",
      agent: { name: "test", instructions: "", emailHandle: "handle" },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("--agent_id specific-agent-id");
    expect(content).not.toContain("email pull --agent_id");
    expect(content).not.toContain("calendar set --agent_id");
    expect(content).toContain("The CLI auto-detects your identity from the environment");
  });

  it("still includes big boss instructions alongside email tools", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "Follow these rules", emailHandle: "myagent" },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("## BIG BOSS Instructions");
  });

  it("includes colleagues section when agent has colleagues", () => {
    const task = makeTask({
      agent: {
        name: "test",
        instructions: "",
        colleagues: [
          { name: "Scout", email: "scout@alook.ai", description: "A researcher agent", instruction: 'Share findings with [@ id="agent-123" label="test"]' },
          { name: "Writer", email: "writer@alook.ai", description: "", instruction: "Draft blog posts" },
        ],
      },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("## YOUR COLLEAGUES");
    expect(content).toContain("### Scout (scout@alook.ai)");
    expect(content).toContain("A researcher agent");
    expect(content).toContain("**DELEGATE when:** Share findings with YOU");
    expect(content).toContain("### Writer (writer@alook.ai)");
    expect(content).toContain("**DELEGATE when:** Draft blog posts");
  });

  it("includes isolated workspaces warning when agent has colleagues", () => {
    const task = makeTask({
      agent: {
        name: "test",
        instructions: "",
        colleagues: [
          { name: "Scout", email: "scout@alook.ai", description: "", instruction: "Research" },
        ],
      },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("**Isolated workspaces:**");
    expect(content).toContain("Colleagues CANNOT read your local files");
    expect(content).toContain("MUST attach the file to the email");
  });

  it("omits colleagues section when no colleagues", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "", colleagues: [] },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("## YOUR COLLEAGUES");
  });

  it("omits colleagues section when colleagues undefined", () => {
    const task = makeTask({
      agent: { name: "test", instructions: "" },
    });
    const content = buildInstructionContent(task);

    expect(content).not.toContain("## YOUR COLLEAGUES");
  });

  it("omits description line for colleague with empty description", () => {
    const task = makeTask({
      agent: {
        name: "test",
        instructions: "",
        colleagues: [
          { name: "Scout", email: "scout@alook.ai", description: "", instruction: "Share data" },
        ],
      },
    });
    const content = buildInstructionContent(task);

    expect(content).toContain("### Scout (scout@alook.ai)");
    expect(content).toContain("**DELEGATE when:** Share data");
    // Only the header + relationship, no blank description line
    const scoutSection = content.split("### Scout")[1].split("##")[0];
    expect(scoutSection).not.toMatch(/\n\n\n/);
  });
});

describe("resolveInstruction", () => {
  it("converts self-mentions to YOU", () => {
    const md = 'when [@ id="ag_abc" label="gus"] is asked to implement';
    expect(resolveInstruction(md, "ag_abc")).toBe("when YOU is asked to implement");
  });

  it("preserves other agent mentions as @name", () => {
    const md = 'share with [@ id="ag_other" label="planner"]';
    expect(resolveInstruction(md, "ag_abc")).toBe("share with @planner");
  });

  it("handles both self and other mentions in the same instruction", () => {
    const md = '[@ id="ag_abc" label="gus"] should report to [@ id="ag_other" label="planner"]';
    expect(resolveInstruction(md, "ag_abc")).toBe("YOU should report to @planner");
  });

  it("returns empty string for empty input", () => {
    expect(resolveInstruction("", "ag_abc")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(resolveInstruction("just plain text", "ag_abc")).toBe("just plain text");
  });

  it("handles legacy HTML mentions as fallback", () => {
    const html = '<p>when <span class="mention-highlight" data-type="mention" data-id="ag_abc" data-label="gus">@gus</span> asks YOU to help</p>';
    expect(resolveInstruction(html, "ag_abc")).toBe("when YOU asks YOU to help");
  });
});
