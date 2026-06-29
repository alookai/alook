import { describe, it, expect } from "vitest";
import { buildCliSystemPrompt } from "./systemPrompt";
import type { LaunchConfig } from "../types";

const baseConfig: LaunchConfig = {
  runtimeContext: {
    agentId: "agent_7",
    serverId: "srv_3",
    computerId: "comp_1",
    computerName: "Box",
    hostname: "box.local",
    os: "darwin",
    daemonVersion: "0.61.1",
    workspacePath: "/ws",
  },
};

describe("buildCliSystemPrompt — host-neutral slim default", () => {
  const prompt = buildCliSystemPrompt(baseConfig, {
    messageNotificationStyle: "direct",
    includeStdinNotificationSection: true,
  });

  it("keeps the host-neutral core sections", () => {
    expect(prompt).toContain("You are an AI agent operating in");
    expect(prompt).toContain("## CLI tool");
    expect(prompt).toContain("## Sending & receiving messages");
    expect(prompt).toContain("## Privacy & Security");
    expect(prompt).toContain("## On wake");
    expect(prompt).toContain("## Communication in Alook");
    expect(prompt).toContain("## Channel awareness");
    expect(prompt).toContain("## Workspace & Memory");
    expect(prompt).toContain("## Message Notifications");
  });

  it("does NOT bake in any platform's protocol conventions", () => {
    // Platform-specific details belong to the host's communicationGuide.
    expect(prompt).not.toContain("RFC 5424");
    expect(prompt).not.toContain(":shortid");
    expect(prompt).not.toContain("todo → in_progress");
    expect(prompt).not.toContain("MEMORY.md");
    expect(prompt).not.toMatch(/##\s*CRITICAL RULES/);
  });

  it("uses the configured cli name everywhere", () => {
    const p = buildCliSystemPrompt(baseConfig, { cli: "raft", messageNotificationStyle: "direct" });
    expect(p).toContain("`raft`");
    expect(p).not.toContain("`alook`");
  });
});

describe("buildCliSystemPrompt — runtime-driven notification section", () => {
  it("direct (steering) describes busy-time notices", () => {
    const p = buildCliSystemPrompt(baseConfig, { messageNotificationStyle: "direct" });
    expect(p).toContain("inbox notice");
    expect(p).toContain("inbox pull");
  });

  it("poll (per-turn) describes re-checking each wake", () => {
    const p = buildCliSystemPrompt(baseConfig, { messageNotificationStyle: "poll" });
    expect(p).toContain("once per wake");
    expect(p).toContain("inbox pull");
  });

  it("omits the notification section when disabled", () => {
    const p = buildCliSystemPrompt(baseConfig, { includeStdinNotificationSection: false });
    expect(p).not.toContain("## Message Notifications");
  });
});

describe("buildCliSystemPrompt — host injection points", () => {
  it("appends the host communicationGuide verbatim", () => {
    const guide = "## Communication\nUse `raft message send` with the [target=…] header.";
    const p = buildCliSystemPrompt(baseConfig, { communicationGuide: guide });
    expect(p).toContain(guide);
  });

  it("appends extraCriticalRules and postStartupNotes when provided", () => {
    const p = buildCliSystemPrompt(baseConfig, {
      extraCriticalRules: ["Claim a task before working on it."],
      postStartupNotes: ["Process stays alive across turns."],
    });
    expect(p).toContain("## Additional rules");
    expect(p).toContain("Claim a task before working on it.");
    expect(p).toContain("## Notes");
    expect(p).toContain("Process stays alive across turns.");
  });

  it("includes the role when config.description is set", () => {
    const p = buildCliSystemPrompt({ ...baseConfig, description: "You are the onboarding assistant." }, {});
    expect(p).toContain("## Role");
    expect(p).toContain("You are the onboarding assistant.");
  });
});
