import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorDriver } from "./cursor";
import type { LaunchContext } from "../types";
import { CredentialBroker } from "../credentials/credentialProxy";

// Capture the argv the driver spawns with, so we can assert the flag set the
// cursor-agent CLI actually accepts today (the `--yolo/--approve-mcps/--trust`
// trio was removed — passing them fails arg-parse → pre_handshake_exit).
let lastSpawn: { command: string; args: string[]; opts: any } | null = null;

vi.mock("@alook/agent-driver", async () => {
  const actual = await vi.importActual<typeof import("@alook/agent-driver")>("@alook/agent-driver");
  return {
    ...actual,
    spawnAgentDriverProcess: (command: string, args: string[], opts: any) => {
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

function baseCtx(): LaunchContext {
  const tmp = mkTmp();
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory: tmp,
    standingPrompt: "You are Cursor.",
    prompt: "say hi",
    credentialProxy: {
      broker: new CredentialBroker({ upstreamBaseUrl: "https://u.test", voucherDir: mkTmp() }),
      proxyUrl: "http://127.0.0.1:9/proxy",
      runnerKey: "sk_agent_test",
      capabilities: ["send", "read"],
    },
    config: {},
    mockCliTransport: true,
  };
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
