import { describe, expect, it, vi } from "vitest";
import {
  appendRecentContextToPrompt,
  createRecentContextPromptAppender,
} from "./recentContextPrompt.js";

describe("appendRecentContextToPrompt", () => {
  it("appends readable session and project pointers below the original prompt", () => {
    const prompt = appendRecentContextToPrompt("# Role briefing", {
      ok: true,
      sessionFiles: {
        capability: "supported",
        items: [{
          sessionFilePath: "/Users/ada/.codex/sessions/one.jsonl",
          projectPath: "/Users/ada/code/app",
          modifiedAt: "2026-09-07T06:00:00.000Z",
        }],
      },
      recentProjects: [{
        projectPath: "/Users/ada/code/app",
        modifiedAt: "2026-09-07T05:00:00.000Z",
      }],
    });

    expect(prompt.startsWith("# Role briefing\n\n## Recent local context")).toBe(true);
    expect(prompt).toContain("### Recent sessions");
    expect(prompt).toContain("`/Users/ada/.codex/sessions/one.jsonl`");
    expect(prompt).toContain("Do not read every session in full");
    expect(prompt).toContain("read the beginning to understand what the user wanted");
    expect(prompt).toContain("read the end to see the result");
    expect(prompt).toContain("Read the middle selectively");
    expect(prompt).toContain("### Recent projects");
    expect(prompt).toContain("`/Users/ada/code/app`");
  });

  it("states when session files are unavailable without hiding projects", () => {
    const prompt = appendRecentContextToPrompt("Brief", {
      ok: true,
      sessionFiles: { capability: "unavailable", items: [] },
      recentProjects: [{
        projectPath: "/Users/ada/code/site",
        modifiedAt: "2026-09-07T05:00:00.000Z",
      }],
    });

    expect(prompt).toContain("does not expose discoverable session files");
    expect(prompt).toContain("`/Users/ada/code/site`");
  });

  it("keeps discovery failures honest and non-blocking", () => {
    const prompt = appendRecentContextToPrompt("Brief", {
      ok: false,
      error: {
        category: "runtime_unavailable",
        code: "recent_context_discovery_failed",
        message: "private diagnostic",
        retryable: true,
      },
    });

    expect(prompt).toContain("could not be discovered");
    expect(prompt).toContain("ask the owner");
    expect(prompt).not.toContain("private diagnostic");
  });

  it("discovers with the event runtime and command override", async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      sessionFiles: { capability: "supported" as const, items: [] },
      recentProjects: [],
    }));
    const append = createRecentContextPromptAppender(discover, 10, 5);

    await append("Brief", {
      version: 1,
      runtime: "codex",
      model: { kind: "default" },
      mode: { kind: "default" },
      command: "/opt/codex",
    });

    expect(discover).toHaveBeenCalledWith({
      backend: "codex",
      command: "/opt/codex",
      recentSessionFilesTopK: 10,
      recentProjectsTopK: 5,
    });
  });

  it("defaults to ten recent sessions and five recent projects", async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      sessionFiles: { capability: "supported" as const, items: [] },
      recentProjects: [],
    }));
    const append = createRecentContextPromptAppender(discover);

    await append("Brief", {
      version: 1,
      runtime: "codex",
      model: { kind: "default" },
      mode: { kind: "default" },
    });

    expect(discover).toHaveBeenCalledWith({
      backend: "codex",
      recentSessionFilesTopK: 10,
      recentProjectsTopK: 5,
    });
  });

  it("keeps delivery non-blocking when the discovery seam rejects", async () => {
    const append = createRecentContextPromptAppender(
      vi.fn().mockRejectedValue(new Error("private diagnostic")),
    );

    const prompt = await append("Brief", {
      version: 1,
      runtime: "codex",
      model: { kind: "default" },
      mode: { kind: "default" },
    });

    expect(prompt).toContain("Recent sessions and projects could not be discovered");
    expect(prompt).not.toContain("private diagnostic");
  });
});
