import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorDriver } from "./index.js";
import type { AdapterLaunchContext } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";

// Capture the argv the driver spawns with, so we can assert the flag set the
// cursor-agent CLI actually accepts today (the `--yolo/--approve-mcps/--trust`
// trio was removed — passing them fails arg-parse → pre_handshake_exit).
let lastSpawn: { command: string; args: string[]; opts: any } | null = null;

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return {
    ...actual,
    spawnAgentProcess: (command: string, args: string[], opts: any) => {
      lastSpawn = { command, args, opts };
      const proc = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn> } };
      proc.stdin = { write: vi.fn() };
      return proc as never;
    },
  };
});

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
}

function baseCtx(): AdapterLaunchContext {
  const tmp = mkTmp();
  return fakeLaunchContext("cursor", tmp, {
    standingPrompt: "You are Cursor.",
    prompt: "say hi",
  });
}

describe("CursorDriver spawn args", () => {
  it("launches with --force and NOT the removed --yolo/--approve-mcps/--trust flags", async () => {
    lastSpawn = null;
    const driver = new CursorDriver();
    await driver.spawn(baseCtx());

    expect(lastSpawn).not.toBeNull();
    const args = lastSpawn!.args;
    // The current cursor-agent permission posture.
    expect(args).toContain("--force");
    expect(args).toEqual(expect.arrayContaining(["--print", "--output-format", "stream-json"]));
    // The removed flags must be gone — any of them makes cursor-agent exit at
    // arg-parse ("unknown option") before the handshake (pre_handshake_exit).
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--approve-mcps");
    expect(args).not.toContain("--trust");
    // Prompt is passed as the trailing arg (per-turn, no stdin).
    expect(args[args.length - 1]).toBe("say hi");
    // stdin MUST be "ignore" — cursor-agent hangs on a piped stdin (emits
    // nothing → handshake_timeout) even with the prompt in a positional arg.
    expect(lastSpawn!.opts.stdin).toBe("ignore");
  });

  it("appends --resume when resuming, still with --force and no removed flags", async () => {
    lastSpawn = null;
    const driver = new CursorDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "chat_42" };
    await driver.spawn(ctx);

    const args = lastSpawn!.args;
    expect(args).toContain("--force");
    expect(args).toEqual(expect.arrayContaining(["--resume", "chat_42"]));
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--approve-mcps");
    expect(args).not.toContain("--trust");
  });
});

describe("CursorDriver normalizeLine", () => {
  it("exposes its per-turn no-stdin contract", () => {
    const driver = new CursorDriver();
    expect(driver.currentSessionId).toBeNull();
    expect(driver.encodeMessage()).toBeNull();
  });

  it("normalizes assistant blocks with defensive defaults", () => {
    const driver = new CursorDriver();
    expect(driver.normalizeLine(JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "thinking" },
        { type: "text", text: "answer" },
        { type: "tool_use", input: { value: 1 } },
      ] },
    }))).toEqual([
      { kind: "thinking", text: "" },
      { kind: "text", text: "answer" },
      { kind: "tool_call", name: "unknown_tool", input: { value: 1 } },
    ]);
  });

  it("normalizes successful and failed results", () => {
    const driver = new CursorDriver();
    expect(driver.normalizeLine(JSON.stringify({ type: "result", subtype: "success", session_id: "s1" })))
      .toEqual([{ kind: "turn_end", sessionId: "s1" }]);
    expect(driver.normalizeLine(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      errors: [{ message: "first" }, { message: "second" }],
    }))).toEqual([
      { kind: "error", message: "first; second" },
      { kind: "turn_end", sessionId: undefined },
    ]);
  });
});
