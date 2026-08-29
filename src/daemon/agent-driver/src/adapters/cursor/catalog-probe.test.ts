import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import {
  parseCursorAcpModelCatalog,
  probeCursorAcpCatalog,
} from "./catalog-probe.js";

type FakeProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  emit(event: string, ...args: unknown[]): boolean;
};

function fakeProcess(onMessage: (process: FakeProcess, message: Record<string, unknown>) => void): FakeProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as FakeProcess;
  let buffer = "";
  stdin.on("data", (chunk) => {
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

describe("Cursor ACP model catalog", () => {
  it("normalizes nested exact values, preserves duplicate labels, and omits ACP Auto", () => {
    expect(parseCursorAcpModelCatalog({
      sessionId: "probe",
      configOptions: [{
        id: "model",
        options: [
          { value: "default[]", name: "Auto" },
          [
            { value: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
            { value: "grok-4.6[effort=max,fast=true]", name: "grok-4.6" },
          ],
          {
            name: "Anthropic",
            options: [{ value: "claude-opus-4.1", name: "Claude Opus 4.1" }],
          },
          { value: "claude-opus-4.1", name: "duplicate loses" },
          { value: "bad value", name: "invalid whitespace" },
        ],
      }],
    })).toEqual({
      updateMode: "unsupported",
      models: [
        {
          id: "grok-4.6[effort=high,fast=true]",
          displayName: "grok-4.6",
          supportedReasoningEfforts: [],
        },
        {
          id: "grok-4.6[effort=max,fast=true]",
          displayName: "grok-4.6",
          supportedReasoningEfforts: [],
        },
        {
          id: "claude-opus-4.1",
          displayName: "Claude Opus 4.1",
          supportedReasoningEfforts: [],
        },
      ],
    });
  });

  it("drops malformed labels without dropping exact values and fails closed on overflow", () => {
    expect(parseCursorAcpModelCatalog({
      configOptions: [{
        id: "model",
        options: [{ value: "gpt-5.6-sol", name: "x".repeat(257) }],
      }],
    })).toEqual({
      updateMode: "unsupported",
      models: [{ id: "gpt-5.6-sol", supportedReasoningEfforts: [] }],
    });
    expect(parseCursorAcpModelCatalog({
      configOptions: [{
        id: "model",
        options: Array.from({ length: 513 }, (_, index) => ({ value: `model-${index}` })),
      }],
    })).toBeUndefined();
  });

  it("uses only initialize/auth/session-new, returns exact ACP values, and cleans once", async () => {
    const messages: Record<string, unknown>[] = [];
    const cleanup = vi.fn(async () => {});
    const process = fakeProcess((proc, message) => {
      messages.push(message);
      if (message.method === "initialize") {
        respond(proc, message, {
          protocolVersion: 1,
          authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
        });
      } else if (message.method === "authenticate") {
        respond(proc, message, null);
      } else if (message.method === "session/new") {
        respond(proc, message, {
          sessionId: "empty-probe-session",
          configOptions: [{
            id: "model",
            options: [{ value: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" }],
          }],
        });
      }
    });
    const spawn = vi.fn(() => process);

    await expect(probeCursorAcpCatalog("/custom/cursor-agent", {
      cwd: "/safe/workspace",
      spawn,
      cleanup,
      timeoutMs: 100,
    })).resolves.toEqual({
      updateMode: "unsupported",
      models: [{
        id: "grok-4.6[effort=high,fast=true]",
        displayName: "grok-4.6",
        supportedReasoningEfforts: [],
      }],
    });
    expect(spawn).toHaveBeenCalledWith(
      "/custom/cursor-agent",
      ["acp"],
      expect.objectContaining({ cwd: "/safe/workspace" }),
    );
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
    ]);
    expect(messages.some((message) => message.method === "session/prompt")).toBe(false);
    expect(messages.at(-1)?.params).toEqual({ cwd: "/safe/workspace", mcpServers: [] });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails non-fatally and cleans on protocol/auth errors, malformed output, size, exit races, and timeout", async () => {
    const cases = [
      (process: FakeProcess, message: Record<string, unknown>) => {
        if (message.method === "initialize") respond(process, message, { protocolVersion: 2, authMethods: [] });
      },
      (process: FakeProcess, message: Record<string, unknown>) => {
        if (message.method === "initialize") respond(process, message, { protocolVersion: 1, authMethods: [] });
      },
      (process: FakeProcess) => {
        process.stdout.write("not-json\n");
        process.emit("exit", 1, null);
        process.emit("error", new Error("late"));
      },
    ];

    for (const onMessage of cases) {
      const cleanup = vi.fn(async () => {});
      const process = fakeProcess(onMessage);
      await expect(probeCursorAcpCatalog(undefined, {
        spawn: () => process,
        cleanup,
        timeoutMs: 25,
      })).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(1);
    }

    const sizeCleanup = vi.fn(async () => {});
    const oversized = fakeProcess((process) => process.stdout.write("x".repeat(65)));
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => oversized,
      cleanup: sizeCleanup,
      timeoutMs: 25,
      outputMaxBytes: 64,
    })).resolves.toBeUndefined();
    expect(sizeCleanup).toHaveBeenCalledTimes(1);

    const timeoutCleanup = vi.fn(async () => {});
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => fakeProcess(() => {}),
      cleanup: timeoutCleanup,
      timeoutMs: 10,
    })).resolves.toBeUndefined();
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);
  });

  it("covers spawn, write, session-id, stderr-size, and pidless cleanup failures", async () => {
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => { throw new Error("spawn failed"); },
    })).resolves.toBeUndefined();

    const unwritable = fakeProcess(() => {});
    unwritable.stdin.write = vi.fn(() => { throw new Error("write failed"); });
    const writeCleanup = vi.fn(async () => {});
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => unwritable,
      cleanup: writeCleanup,
      timeoutMs: 25,
    })).resolves.toBeUndefined();
    expect(writeCleanup).toHaveBeenCalledTimes(1);

    const invalidSessionCleanup = vi.fn(async () => {});
    const invalidSession = fakeProcess((process, message) => {
      if (message.method === "initialize") {
        respond(process, message, { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] });
      } else if (message.method === "authenticate") {
        respond(process, message, null);
      } else if (message.method === "session/new") {
        respond(process, message, { sessionId: "" });
      }
    });
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => invalidSession,
      cleanup: invalidSessionCleanup,
      timeoutMs: 25,
    })).resolves.toBeUndefined();
    expect(invalidSessionCleanup).toHaveBeenCalledTimes(1);

    const stderrCleanup = vi.fn(async () => {});
    const stderrOversized = fakeProcess((process) => process.stderr.write("x".repeat(65)));
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => stderrOversized,
      cleanup: stderrCleanup,
      timeoutMs: 25,
      outputMaxBytes: 64,
    })).resolves.toBeUndefined();
    expect(stderrCleanup).toHaveBeenCalledTimes(1);

    const pidless = fakeProcess((process, message) => {
      if (message.method === "initialize") respond(process, message, { protocolVersion: 2 });
    });
    Object.defineProperty(pidless, "pid", { value: undefined });
    await expect(probeCursorAcpCatalog(undefined, {
      spawn: () => pidless,
      timeoutMs: 25,
    })).resolves.toBeUndefined();
    expect(pidless.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
