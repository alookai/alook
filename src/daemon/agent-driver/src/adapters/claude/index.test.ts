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
  it("reports an explicit missing command as unhealthy", () => {
    expect(new ClaudeDriver().probe("/definitely/missing/alook-claude")).toMatchObject({
      status: "unhealthy",
      lastError: expect.any(String),
    });
  });

  it("encodes same-turn safe-boundary input with the active resumed session", () => {
    const driver = new ClaudeDriver();
    const rootReceipt = driver.beginTurn();
    const idle = JSON.parse(driver.encodeMessage("first", "session-1", { mode: "idle" }));
    const busy = JSON.parse(driver.encodeMessage("follow up", "session-1", { mode: "busy" }));
    expect(idle).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "first" }] },
      uuid: rootReceipt.slice("claude:".length),
      session_id: "session-1",
    });
    expect(busy).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "follow up" }] },
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      priority: "now",
      session_id: "session-1",
    });
    expect(busy.uuid).not.toBe(idle.uuid);
  });

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
    const receipt = driver.beginTurn();
    await expect(driver.spawn(ctx)).resolves.toEqual({ process });
    expect(spawnAgentProcess).toHaveBeenCalledWith(
      "/custom/claude",
      expect.any(Array),
      expect.objectContaining({ cwd: workingDirectory }),
    );
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"text":"hello"'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`"uuid":"${receipt.slice("claude:".length)}"`));
  });
});
