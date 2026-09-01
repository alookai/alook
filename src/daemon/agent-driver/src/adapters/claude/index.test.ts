import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProbeResult } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { ClaudeDriver } from "./index.js";

const spawnAgentProcess = vi.hoisted(() => vi.fn());
const probeClaude = vi.hoisted(() => vi.fn<() => ProbeResult>());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  spawnAgentProcess,
}));
vi.mock("../../internal/probe.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/probe.js")>("../../internal/probe.js")),
  probeClaude,
}));

const directories: string[] = [];
afterEach(() => {
  spawnAgentProcess.mockReset();
  probeClaude.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ClaudeDriver", () => {
  it("reports an explicit missing command as unhealthy", () => {
    expect(new ClaudeDriver().probe("/definitely/missing/alook-claude")).toMatchObject({
      status: "unhealthy",
      lastError: expect.any(String),
    });
  });

  it("reports only the three stable Claude aliases after a healthy probe", () => {
    probeClaude.mockReturnValue({ status: "healthy", version: "1.2.3" });

    expect(new ClaudeDriver().probe()).toEqual({
      status: "healthy",
      version: "1.2.3",
      reasoning: {
        updateMode: "unsupported",
        models: [
          { id: "opus", supportedReasoningEfforts: [] },
          { id: "sonnet", supportedReasoningEfforts: [] },
          { id: "haiku", supportedReasoningEfforts: [] },
        ],
      },
    });
  });

  it("keeps an unhealthy default Claude probe unchanged without adding a catalog", () => {
    probeClaude.mockReturnValue({ status: "unhealthy", lastError: "not_on_path" });

    expect(new ClaudeDriver().probe()).toEqual({
      status: "unhealthy",
      lastError: "not_on_path",
    });
  });

  it("encodes same-turn safe-boundary input with the active resumed session", () => {
    const driver = new ClaudeDriver();
    expect(driver.currentSessionId).toBeNull();
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

  it("interrupts an active turn with a native control request without signaling the process", async () => {
    const stdin = new PassThrough();
    const write = vi.spyOn(stdin, "write");
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const driver = new ClaudeDriver();
    const receipt = driver.beginTurn();
    const root = receipt.slice("claude:".length);
    driver.normalizeLine(JSON.stringify({ type: "user", uuid: root, isReplay: true }));

    await expect(driver.interrupt(
      { requestId: "interrupt-1", reason: "owner_request" },
      process,
    )).resolves.toBe(true);

    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({
      type: "control_request",
      request_id: "interrupt-1",
      request: { subtype: "interrupt" },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("defers a pre-root-ack interrupt until root replay and writes one native frame", async () => {
    const stdin = new PassThrough();
    const write = vi.spyOn(stdin, "write");
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const driver = new ClaudeDriver();
    const receipt = driver.beginTurn();
    const root = receipt.slice("claude:".length);

    await expect(driver.interrupt(
      { requestId: "interrupt-before-ack", reason: "owner_request" },
      process,
    )).resolves.toBe(true);
    await expect(driver.interrupt(
      { requestId: "retry-before-ack", reason: "owner_request" },
      process,
    )).resolves.toBe(true);
    expect(write).not.toHaveBeenCalled();

    driver.normalizeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }));
    expect(write).not.toHaveBeenCalled();
    driver.normalizeLine(JSON.stringify({ type: "user", uuid: root, isReplay: true }));
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({
      type: "control_request",
      request_id: "interrupt-before-ack",
      request: { subtype: "interrupt" },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("accepts a B-owned terminal after Claude's ownerless interrupted A boundary", async () => {
    const stdin = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const driver = new ClaudeDriver();
    const receipt = driver.beginTurn();
    const root = receipt.slice("claude:".length);
    const steering = JSON.parse(driver.encodeMessage("queued", null, { mode: "busy" }));
    driver.normalizeLine(JSON.stringify({ type: "user", uuid: root, isReplay: true }));
    await driver.interrupt({ requestId: "interrupt-queued", reason: "owner_request" }, process);

    expect(driver.normalizeLine(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "aborted_tools",
      is_error: true,
    }))).toEqual([]);
    expect(driver.normalizeLine(JSON.stringify({ type: "user", uuid: steering.uuid, isReplay: true }))).toEqual([]);
    expect(driver.normalizeLine(JSON.stringify({
      type: "result",
      subtype: "success",
      terminal_reason: "completed",
      is_error: false,
      user_message_uuid: steering.uuid,
    }))).toEqual([{
      kind: "turn_end",
      sessionId: undefined,
      turnOwner: receipt,
    }]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("ends an interrupted turn on Claude's ownerless aborted-streaming terminal", async () => {
    const stdin = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const driver = new ClaudeDriver();
    const receipt = driver.beginTurn();
    const root = receipt.slice("claude:".length);
    const steering = JSON.parse(driver.encodeMessage("queued", null, { mode: "busy" }));

    expect(driver.normalizeLine(JSON.stringify({ type: "user", uuid: root, isReplay: true }))).toEqual([]);
    await expect(driver.interrupt(
      { requestId: "interrupt-1", reason: "owner_request" },
      process,
    )).resolves.toBe(true);
    expect(driver.normalizeLine(JSON.stringify({
      type: "result",
      subtype: "success",
      terminal_reason: "aborted_tools",
      user_message_uuid: root,
    }))).toEqual([]);
    expect(driver.normalizeLine(JSON.stringify({ type: "user", uuid: steering.uuid, isReplay: true }))).toEqual([]);
    expect(driver.normalizeLine(JSON.stringify({
      type: "user",
      uuid: "synthetic-interrupt",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    }))).toEqual([]);

    const terminal = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    });
    expect(driver.normalizeLine(terminal)).toEqual([{
      kind: "turn_end",
      sessionId: undefined,
      turnOwner: receipt,
    }]);
    expect(driver.normalizeLine(terminal)).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("ends a pre-ack interrupt on Claude's ownerless aborted-tools terminal", async () => {
    const stdin = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const driver = new ClaudeDriver();
    const receipt = driver.beginTurn();
    const root = receipt.slice("claude:".length);

    await expect(driver.interrupt(
      { requestId: "interrupt-before-root-ack", reason: "owner_request" },
      process,
    )).resolves.toBe(true);
    expect(driver.normalizeLine(JSON.stringify({ type: "user", uuid: root, isReplay: true }))).toEqual([]);
    expect(driver.normalizeLine(JSON.stringify({
      type: "user",
      uuid: "synthetic-interrupt",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    }))).toEqual([]);

    const terminal = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
    });
    expect(driver.normalizeLine(terminal)).toEqual([{
      kind: "turn_end",
      sessionId: undefined,
      turnOwner: receipt,
    }]);
    expect(driver.normalizeLine(terminal)).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("does not send a control request when no Claude turn is active", async () => {
    const stdin = new PassThrough();
    const write = vi.spyOn(stdin, "write");
    const process = Object.assign(new EventEmitter(), {
      stdin,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });

    await expect(new ClaudeDriver().interrupt(
      { requestId: "interrupt-1", reason: "owner_request" },
      process,
    )).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  });
});
