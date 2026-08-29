import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { OpenCodeDriver } from "./index.js";

const spawnAgentProcess = vi.hoisted(() => vi.fn());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  spawnAgentProcess,
}));

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCodeDriver persistent v2 service", () => {
  let driver: OpenCodeDriver;

  beforeEach(() => {
    driver = new OpenCodeDriver();
  });

  it("uses models --pure output for a non-fatal startup catalog", () => {
    const outputProbe = vi.fn(() => ({
      ok: true as const,
      output: "openai/gpt-5\nanthropic/claude-sonnet\n",
    }));
    const result = new OpenCodeDriver(outputProbe).probe(process.execPath);

    expect(outputProbe).toHaveBeenCalledWith(process.execPath, ["models", "--pure"]);
    expect(result).toMatchObject({
      status: "healthy",
      reasoning: {
        models: [
          { id: "openai/gpt-5", supportedReasoningEfforts: [] },
          { id: "anthropic/claude-sonnet", supportedReasoningEfforts: [] },
        ],
      },
    });
  });

  it("keeps runtime health healthy when models --pure fails", () => {
    expect(new OpenCodeDriver(() => ({ ok: false, error: "ETIMEDOUT" })).probe(process.execPath))
      .toMatchObject({ status: "healthy", reasoning: undefined });
  });

  it("declares persistent HTTP/SSE steering with transport-owned terminal receipts", () => {
    expect(driver.execution).toEqual({
      lifetime: "session",
      transport: { kind: "http_sse", protocol: "opencode.v2.service.1.17.20" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    });
    expect("normalizeLine" in driver).toBe(false);
  });

  it("creates opaque caller message ids for root ownership", () => {
    const first = driver.beginTurn();
    const second = driver.beginTurn();
    expect(first).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(second).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it("opens a persistent service lane without spawning before start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-lane-"));
    directories.push(directory);
    await expect(driver.openLane(fakeLaunchContext("opencode", directory))).resolves.toMatchObject({
      currentSessionId: null,
    });
    expect(spawnAgentProcess).not.toHaveBeenCalled();
  });

  it("spawns one loopback service without putting its password in argv", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-driver-"));
    directories.push(directory);
    const process = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: null,
      stderr: null,
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    spawnAgentProcess.mockReturnValue(process);

    await driver.spawnService(fakeLaunchContext("opencode", directory, {
      config: { runtimeConfig: { model: { kind: "default" }, command: "opencode-custom" } },
    }), 43123, "session-secret");

    expect(spawnAgentProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnAgentProcess.mock.calls[0]!;
    expect(command).toBe("opencode-custom");
    expect(args).toEqual(["serve", "--pure", "--hostname", "127.0.0.1", "--port", "43123"]);
    expect(JSON.stringify(args)).not.toContain("session-secret");
    expect(options).toMatchObject({
      cwd: directory,
      env: { OPENCODE_SERVER_PASSWORD: "session-secret" },
    });
  });
});
