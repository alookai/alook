import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { ClaudeDriver } from "./index.js";

const spawnAgentProcess = vi.hoisted(() => vi.fn());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  spawnAgentProcess,
}));

const directories: string[] = [];
afterEach(() => {
  spawnAgentProcess.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ClaudeDriver", () => {
  it("spawns the configured command and writes the initial stream-json message", async () => {
    const stdin = new PassThrough();
    const write = vi.spyOn(stdin, "write");
    const process = Object.assign(new EventEmitter(), { stdin });
    spawnAgentProcess.mockReturnValue(process);
    const workingDirectory = mkdtempSync(join(tmpdir(), "claude-driver-"));
    directories.push(workingDirectory);
    const ctx = fakeLaunchContext("claude", workingDirectory, {
      prompt: "hello",
      config: {
        sessionId: "session-1",
        runtimeConfig: {
          model: { kind: "default" },
          provider: { kind: "default" },
          mode: "default",
          command: "/custom/claude",
        },
      },
    });

    const driver = new ClaudeDriver();
    await expect(driver.spawn(ctx)).resolves.toEqual({ process });
    expect(spawnAgentProcess).toHaveBeenCalledWith(
      "/custom/claude",
      expect.any(Array),
      expect.objectContaining({ cwd: workingDirectory }),
    );
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"text":"hello"'));
  });
});
