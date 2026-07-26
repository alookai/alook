import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KimiDriver, KIMI_WIRE_PROTOCOL_VERSION } from "./kimi";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "kimi-test-"));
}

function baseCtx(): LaunchContext {
  const tmp = mkTmp();
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory: tmp,
    standingPrompt: "You are Kimi.",
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

describe("KimiDriver initialize payload", () => {
  it("sends alook-daemon identity and the named protocol version", async () => {
    const driver = new KimiDriver();
    const ctx = baseCtx();
    const { process: proc } = await driver.spawn(ctx);
    const stdin = (proc as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;

    // First stdin write is `initialize`.
    const firstCall = stdin.write.mock.calls[0][0] as string;
    const initPayload = JSON.parse(firstCall.trim());

    expect(initPayload.jsonrpc).toBe("2.0");
    expect(initPayload.method).toBe("initialize");
    expect(initPayload.params.protocol_version).toBe(KIMI_WIRE_PROTOCOL_VERSION);
    expect(initPayload.params.client).toEqual({ name: "alook-daemon", version: readDaemonVersion() });
  });
});
