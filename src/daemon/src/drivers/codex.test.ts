import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexDriver } from "./codex";
import type { LaunchContext } from "../types";
import { CredentialBroker } from "../credentials/credentialProxy";
import { readDaemonVersion } from "../version";

vi.mock("@alook/agent-driver", async () => {
  const actual = await vi.importActual<typeof import("@alook/agent-driver")>("@alook/agent-driver");
  return {
    ...actual,
    spawnAgentDriverProcess: () => {
      const proc = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn> } };
      proc.stdin = { write: vi.fn() };
      return proc as never;
    },
  };
});

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
}

function baseCtx(): LaunchContext {
  const tmp = mkTmp();
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory: tmp,
    standingPrompt: "You are Codex.",
    prompt: "hi",
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

describe("CodexDriver initialize payload", () => {
  it("sends alook-daemon identity via clientInfo (matches Codex's schema)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    const { process: proc } = await driver.spawn(ctx);
    // Codex writes on queueMicrotask — flush.
    await Promise.resolve();

    const stdin = (proc as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;
    const firstCall = stdin.write.mock.calls[0][0] as string;
    const initPayload = JSON.parse(firstCall.trim());

    expect(initPayload.jsonrpc).toBe("2.0");
    expect(initPayload.method).toBe("initialize");
    expect(initPayload.params.clientInfo).toEqual({ name: "alook-daemon", version: readDaemonVersion() });
  });
});

// The `thread/start` (or resume) RESULT line carries the new thread id and is
// what the normalizer adopts as the session — feeding it to parseLine is what
// triggers the deferred initial-prompt delivery.
function threadStartResult(threadId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: threadId } } });
}
// The `thread/started` NOTIFICATION — Codex emits this too, so parseLine sees a
// SECOND session_init for the same thread.
function threadStartedNotif(threadId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
}

function stdinWrites(proc: unknown): string[] {
  const stdin = (proc as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;
  return stdin.write.mock.calls.map((c) => c[0] as string);
}
function turnStarts(writes: string[]): any[] {
  return writes
    .map((w) => JSON.parse(w.trim()))
    .filter((m) => m.method === "turn/start");
}

describe("CodexDriver initial-prompt delivery", () => {
  it("submits the initial prompt as a turn/start once the thread id is adopted", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx(); // prompt: "hi"
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve(); // flush handshake microtask

    // Before the thread is adopted, no turn/start yet — only the handshake.
    expect(turnStarts(stdinWrites(proc))).toHaveLength(0);

    // Feed the thread/start result → thread adopted → prompt delivered.
    driver.parseLine(threadStartResult("th_abc"));

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_abc");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("delivers the prompt exactly once despite the double session_init (result + thread/started)", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();

    driver.parseLine(threadStartResult("th_abc")); // session_init #1
    driver.parseLine(threadStartedNotif("th_abc")); // session_init #2 (same thread)

    expect(turnStarts(stdinWrites(proc))).toHaveLength(1);
  });

  it("delivers the prompt on resume too (thread/resume result yields session_init)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" }; // resuming
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    // resume result carries the (same) thread id.
    driver.parseLine(threadStartResult("th_prior"));

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_prior");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("does not start a turn when the prompt is empty (a bare wake)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.prompt = "   "; // whitespace-only → treated as no prompt
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    driver.parseLine(threadStartResult("th_abc"));

    expect(turnStarts(stdinWrites(proc))).toHaveLength(0);
  });
});

// A JSON-RPC error response to thread/resume — the prior thread's rollout is gone.
function missingRolloutError(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "no rollout found for thread id th_prior" } });
}
function threadStarts(writes: string[]): any[] {
  return writes.map((w) => JSON.parse(w.trim())).filter((m) => m.method === "thread/start");
}

describe("CodexDriver missing-rollout resume recovery", () => {
  it("on a 'no rollout found' resume error, re-issues a FRESH thread/start (no threadId) and swallows the error", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" }; // resuming a now-dead thread
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve(); // flush handshake (writes thread/resume)

    const returned = driver.parseLine(missingRolloutError());

    // The resume error is swallowed — not surfaced to the manager as a fault.
    expect(returned.some((e: any) => e.kind === "error")).toBe(false);
    // A fresh thread/start was issued, with NO threadId (fresh, not resume).
    const starts = threadStarts(stdinWrites(proc));
    expect(starts).toHaveLength(1);
    expect(starts[0].params.threadId).toBeUndefined();
  });

  it("after the fallback fresh-thread's session_init, the held prompt is still delivered", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" };
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    driver.parseLine(missingRolloutError());        // → fresh thread/start, prompt still pending
    driver.parseLine(threadStartResult("th_fresh")); // fresh thread adopted

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_fresh");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("a successful resume does NOT trigger the fallback (no spurious fresh thread/start)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" };
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    // Resume succeeds → session_init for the resumed thread.
    driver.parseLine(threadStartResult("th_prior"));

    // No fallback thread/start — only the handshake's thread/resume happened.
    expect(threadStarts(stdinWrites(proc))).toHaveLength(0);
    // And the prompt was delivered on the resumed thread.
    expect(turnStarts(stdinWrites(proc))).toHaveLength(1);
  });
});

describe("CodexDriver encodeStdinMessage — turn/steer expectedTurnId", () => {
  it("busy steer includes expectedTurnId = the active turn id (codex requires it)", () => {
    const driver = new CodexDriver();
    // Adopt a thread + observe a turn/started so the normalizer has both ids.
    driver.parseLine(threadStartResult("th_1"));
    driver.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_9" } } }));

    const encoded = driver.encodeStdinMessage("hang on", "th_1", { mode: "busy" });
    const msg = JSON.parse(encoded!);
    expect(msg.method).toBe("turn/steer");
    expect(msg.params.threadId).toBe("th_1");
    expect(msg.params.expectedTurnId).toBe("turn_9");
    expect(msg.params.input).toEqual([{ type: "text", text: "hang on" }]);
  });

  it("falls back to a fresh turn/start when there is no live turn to steer", () => {
    const driver = new CodexDriver();
    driver.parseLine(threadStartResult("th_1")); // thread but no active turn
    const encoded = driver.encodeStdinMessage("hi", "th_1", { mode: "busy" });
    const msg = JSON.parse(encoded!);
    // No turn id → don't send an invalid steer; start a fresh turn instead.
    expect(msg.method).toBe("turn/start");
    expect(msg.params.expectedTurnId).toBeUndefined();
  });

  it("idle message is always a fresh turn/start (no expectedTurnId)", () => {
    const driver = new CodexDriver();
    driver.parseLine(threadStartResult("th_1"));
    driver.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_9" } } }));
    const encoded = driver.encodeStdinMessage("new topic", "th_1", { mode: "idle" });
    const msg = JSON.parse(encoded!);
    expect(msg.method).toBe("turn/start");
    expect(msg.params.expectedTurnId).toBeUndefined();
  });
});
