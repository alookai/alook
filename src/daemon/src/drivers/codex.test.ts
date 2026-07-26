import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexDriver } from "./codex";
import type { LaunchContext } from "../types";
import { CredentialBroker } from "../credentials/credentialProxy";
import { readDaemonVersion } from "../version";

vi.mock("../runtime/killTree", async () => {
  const actual = await vi.importActual<typeof import("../runtime/killTree")>("../runtime/killTree");
  return {
    ...actual,
    spawnAgentProcess: () => {
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
