import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { parseGrokModelCatalog, probeGrokAcpCatalog } from "./catalog-probe.js";
import { GrokDriver } from "./index.js";

type FakeProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  emit(event: string, ...args: unknown[]): boolean;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeProcess(onMessage: (process: FakeProcess, message: Record<string, unknown>) => void): FakeProcess {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as FakeProcess;
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onMessage(process, JSON.parse(line) as Record<string, unknown>);
    }
  });
  return process;
}

function respond(process: FakeProcess, request: Record<string, unknown>, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

const modelState = {
  currentModelId: "grok-4.6",
  availableModels: [{
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        { id: "deep", value: "xhigh", description: "Maximum reasoning" },
        { value: "high", default: true },
        { value: "medium" },
        { value: "low" },
      ],
    },
  }],
};

describe("Grok ACP model catalog", () => {
  it("preserves provider ids and dynamic reasoning values", () => {
    expect(parseGrokModelCatalog(modelState)).toEqual({
      updateMode: "live_next_turn",
      defaultModelId: "grok-4.6",
      models: [{
        id: "grok-4.6",
        displayName: "Grok 4.6",
        supportedReasoningEfforts: [
          { value: "xhigh", description: "Maximum reasoning" },
          { value: "high" },
          { value: "medium" },
          { value: "low" },
        ],
        defaultReasoningEffort: "high",
      }],
    });
  });

  it("normalizes models without reasoning and snake-case reasoning metadata", () => {
    expect(parseGrokModelCatalog({
      currentModelId: "plain",
      availableModels: [
        { modelId: "plain", name: "Plain" },
        { modelId: "snake", meta: { supportsReasoningEffort: true, reasoning_efforts: ["high"] } },
        { modelId: "empty", _meta: { supportsReasoningEffort: true } },
      ],
    })).toMatchObject({
      defaultModelId: "plain",
      models: [
        { id: "plain", supportedReasoningEfforts: [] },
        { id: "snake", supportedReasoningEfforts: [{ value: "high" }] },
        { id: "empty", supportedReasoningEfforts: [] },
      ],
    });
  });

  it("uses only initialize/authenticate, never creates a session, and cleans exactly once", async () => {
    const messages: Record<string, unknown>[] = [];
    const cleanup = vi.fn(async () => {});
    const process = fakeProcess((proc, message) => {
      messages.push(message);
      if (message.method === "initialize") {
        respond(proc, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token", name: "Cached token" }, { id: "grok.com" }],
          _meta: { modelState },
        });
      } else if (message.method === "authenticate") {
        respond(proc, message, {});
      }
    });
    let spawn: { command: string; args: string[]; options: { env: NodeJS.ProcessEnv } } | undefined;

    await expect(probeGrokAcpCatalog("/opt/grok", {
      cwd: "/tmp",
      spawn: (command, args, options) => {
        spawn = { command, args, options };
        return process;
      },
      cleanup,
    })).resolves.toEqual({
      status: "compatible",
      reasoning: parseGrokModelCatalog(modelState),
    });

    expect(spawn).toMatchObject({
      command: "/opt/grok",
      args: ["agent", "--no-leader", "stdio"],
      options: { env: { GROK_DISABLE_AUTOUPDATER: "1" } },
    });
    expect(messages.map((message) => message.method)).toEqual(["initialize", "authenticate"]);
    expect(messages.some((message) => String(message.method).startsWith("session/"))).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("accepts the bounded model update fallback after auth", async () => {
    const cleanup = vi.fn(async () => {});
    const process = fakeProcess((proc, message) => {
      if (message.method === "initialize") {
        respond(proc, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token" }],
        });
      } else if (message.method === "authenticate") {
        respond(proc, message, {});
        proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/models/update", params: modelState })}\n`);
      }
    });

    await expect(probeGrokAcpCatalog(undefined, { spawn: () => process, cleanup }))
      .resolves.toEqual({
        status: "compatible",
        reasoning: parseGrokModelCatalog(modelState),
      });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed response", (process: FakeProcess) => process.stdout.write("not-json\n"), "grok_acp_invalid_response"],
    ["protocol mismatch", (process: FakeProcess, message: Record<string, unknown>) => respond(process, message, {
      protocolVersion: 2,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "cached_token" }],
    }), "grok_acp_protocol_incompatible"],
    ["missing loadSession", (process: FakeProcess, message: Record<string, unknown>) => respond(process, message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "cached_token" }],
    }), "grok_acp_load_session_unsupported"],
    ["interactive login required", (process: FakeProcess, message: Record<string, unknown>) => respond(process, message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "grok.com" }],
    }), "grok_acp_authentication_failed"],
    ["unsupported auth shape", (process: FakeProcess, message: Record<string, unknown>) => respond(process, message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "unknown" }],
    }), "grok_acp_cached_auth_unsupported"],
  ] as const)("reports %s as unhealthy without provider details", async (_name, onMessage, lastError) => {
      const cleanup = vi.fn(async () => {});
      await expect(probeGrokAcpCatalog(undefined, {
        spawn: () => fakeProcess(onMessage),
        cleanup,
        timeoutMs: 25,
      })).resolves.toEqual({ status: "unhealthy", lastError });
      expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports authentication failure while accepting authenticated ACP without a catalog", async () => {
    const authFailure = fakeProcess((process, message) => {
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token" }],
        });
      } else {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32_000, message: "secret provider detail" },
        })}\n`);
      }
    });
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => authFailure,
      cleanup: async () => {},
    })).resolves.toEqual({
      status: "unhealthy",
      lastError: "grok_acp_authentication_failed",
    });

    const authenticated = fakeProcess((process, message) => {
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token" }],
        });
      } else {
        respond(process, message, {});
      }
    });
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => authenticated,
      cleanup: async () => {},
      catalogGraceMs: 1,
    })).resolves.toEqual({ status: "compatible" });
  });

  it("reports spawn, process-exit, and initialize failures without leaking details", async () => {
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => { throw new Error("secret spawn detail"); },
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_spawn_failed" });

    const exited = fakeProcess((process) => process.emit("exit", 1, null));
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => exited,
      cleanup: async () => {},
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_process_failed" });

    const initializeFailure = fakeProcess((process, message) => {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_000, message: "secret initialize detail" },
      })}\n`);
    });
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => initializeFailure,
      cleanup: async () => {},
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_initialize_failed" });

    const cleanup = vi.fn(async () => {});
    const exitedAfterAuth = fakeProcess((process, message) => {
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token" }],
        });
      } else {
        respond(process, message, {});
        process.emit("exit", 0, null);
      }
    });
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => exitedAfterAuth,
      cleanup,
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_process_failed" });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized and silent probes with one cleanup", async () => {

    const oversizedCleanup = vi.fn(async () => {});
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => fakeProcess((process) => process.stderr.write("x".repeat(65))),
      cleanup: oversizedCleanup,
      outputMaxBytes: 64,
      timeoutMs: 25,
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_output_limit" });
    expect(oversizedCleanup).toHaveBeenCalledTimes(1);

    const timeoutCleanup = vi.fn(async () => {});
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => fakeProcess(() => {}),
      cleanup: timeoutCleanup,
      timeoutMs: 5,
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_probe_timeout" });
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);
  });

  it("covers default cleanup, transport failures, missing results, and stdout bounds", async () => {
    const cleaned = fakeProcess((process, message) => {
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cached_token" }],
          _meta: { modelState },
        });
      } else {
        respond(process, message, {});
      }
    });
    Object.defineProperty(cleaned, "pid", { value: undefined, configurable: true });
    await expect(probeGrokAcpCatalog(undefined, { spawn: () => cleaned })).resolves.toMatchObject({
      status: "compatible",
    });
    expect(cleaned.kill).toHaveBeenCalledWith("SIGTERM");

    const unavailable = fakeProcess(() => {});
    unavailable.stdin.end();
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => unavailable,
      cleanup: async () => {},
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_transport_unavailable" });

    const throwing = fakeProcess(() => {});
    throwing.stdin.write = (() => { throw new Error("closed"); }) as typeof throwing.stdin.write;
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => throwing,
      cleanup: async () => {},
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_transport_unavailable" });

    const omitted = fakeProcess((process, message) => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id })}\n`);
    });
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => omitted,
      cleanup: async () => {},
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_invalid_response" });

    const oversized = fakeProcess((process) => process.stdout.write("x".repeat(65)));
    await expect(probeGrokAcpCatalog(undefined, {
      spawn: () => oversized,
      cleanup: async () => {},
      outputMaxBytes: 64,
    })).resolves.toEqual({ status: "unhealthy", lastError: "grok_acp_output_limit" });
  });
});

describe("GrokDriver launch boundary", () => {
  it("declares persistent safe-boundary ACP and launches the owned no-leader process", async () => {
    const spawn = vi.fn(() => fakeProcess(() => {}));
    const driver = new GrokDriver(async () => ({ status: "compatible" }), spawn);
    const workingDirectory = mkdtempSync(join(tmpdir(), "grok-driver-test-"));
    temporaryDirectories.push(workingDirectory);
    const context = fakeLaunchContext("grok", workingDirectory, {
      config: {
        runtimeConfig: {
          model: { kind: "default" },
          environment: { GROK_DISABLE_AUTOUPDATER: "0", USER_VALUE: "kept" },
          command: process.execPath,
        },
      },
    });

    await driver.spawn(context);

    expect(driver.execution).toEqual({
      lifetime: "session",
      transport: { kind: "stdio_rpc", protocol: "grok.acp.v1" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["agent", "--no-leader", "stdio"], expect.objectContaining({
      cwd: workingDirectory,
      shell: false,
      env: expect.objectContaining({ GROK_DISABLE_AUTOUPDATER: "1", USER_VALUE: "kept" }),
    }));
  });

  it("requires an authenticated compatible ACP probe before reporting healthy", async () => {
    const catalog = parseGrokModelCatalog(modelState);
    const success = vi.fn(async () => ({ status: "compatible" as const, reasoning: catalog }));
    await expect(new GrokDriver(success).probe(process.execPath)).resolves.toMatchObject({
      status: "healthy",
      reasoning: catalog,
    });
    expect(success).toHaveBeenCalledWith(process.execPath);

    await expect(new GrokDriver(async () => ({ status: "compatible" })).probe(process.execPath))
      .resolves.toMatchObject({ status: "healthy", reasoning: undefined });

    await expect(new GrokDriver(async () => ({
      status: "unhealthy",
      lastError: "grok_acp_authentication_failed",
    })).probe(process.execPath)).resolves.toMatchObject({
      status: "unhealthy",
      lastError: "grok_acp_authentication_failed",
    });
    await expect(new GrokDriver(async () => { throw new Error("provider secret"); }).probe(process.execPath))
      .resolves.toMatchObject({ status: "unhealthy", lastError: "grok_acp_probe_failed" });
  });
});
