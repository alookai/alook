import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PiDriver,
  PI_IGNORED_EVENT_TYPES,
  mapPiSdkEvent,
  resolvePiSdkVersionFromPath,
  resolvePiSdkPackageDir,
  findPiSessionFile,
} from "./index.js";
import { CANONICAL_FILE } from "../../internal/agentFile.js";
import { capabilitiesFor, createAgentDriverRegistry } from "../../registry.js";
import { createAgentDriverSdkWithRegistry } from "../../sdk.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import type { BuiltinBackendSpecs } from "../../contract.js";
import type { AdapterLaunchContext } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-driver-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseCtx(overrides: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext {
  return fakeLaunchContext("pi", tmpDir, {
    standingPrompt: "You are Pi.",
    prompt: "hello",
    ...overrides,
  });
}

function fakeDeps() {
  const session = {
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    isStreaming: false,
    subscribe: vi.fn(),
  };
  const createAgentSession = vi.fn().mockResolvedValue({ session, sessionId: "sess_1" });
  const buildSpawnEnv = vi.fn().mockResolvedValue({});
  return { buildSpawnEnv, createAgentSession, session };
}

describe("PiDriver.openLane — AGENTS.md packing", () => {
  it("exposes SDK-only parser and encoder no-ops", () => {
    const driver = new PiDriver(() => fakeDeps());
    expect(driver.normalizeLine()).toEqual([]);
    expect(driver.encodeMessage()).toBeNull();
  });

  it("does not write AGENTS.md itself — the logical-session core is the single packing point", async () => {
    const deps = fakeDeps();
    const driver = new PiDriver(() => deps);

    await driver.openLane(baseCtx());

    // The adapter does not duplicate the core's instruction materialization.
    expect(fs.existsSync(path.join(tmpDir, CANONICAL_FILE))).toBe(false);

    const sessionOpts = deps.createAgentSession.mock.calls[0][0];
    expect(sessionOpts).not.toHaveProperty("standingPrompt");
  });
});

describe("PiDriver.openLane — does not fire the initial prompt itself", () => {
  it("returns without calling session.prompt — the caller (logical session) sends the first turn", async () => {
    const deps = fakeDeps();
    const driver = new PiDriver(() => deps);

    const runtimeSession = await driver.openLane(baseCtx());

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(runtimeSession.currentSessionId).toBe("sess_1");
  });

  it("wires session.subscribe before returning, so events fired by a later prompt() call are not lost", async () => {
    const deps = fakeDeps();
    const driver = new PiDriver(() => deps);

    const runtimeSession = await driver.openLane(baseCtx());
    const received: unknown[] = [];
    runtimeSession.on("runtime_event", (e) => received.push(e));

    // Simulate the SDK emitting a text_delta while handling a prompt sent
    // later, via the subscribe callback deps.session.subscribe captured.
    const subscribeCb = deps.session.subscribe.mock.calls[0][0];
    subscribeCb({ type: "message_update", delta: { type: "text_delta", delta: "hi" } });

    expect(received).toEqual([
      { kind: "session_init", sessionId: "sess_1" },
      { kind: "text", text: "hi" },
    ]);
  });

  it("binds terminal ownership to each prompt promise and ignores duplicate content-identical agent_end events", async () => {
    const deps = fakeDeps();
    const prompts: Array<{ resolve: () => void; promise: Promise<void> }> = [];
    deps.session.prompt.mockImplementation(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      prompts.push({ resolve, promise });
      return promise;
    });
    const driver = new PiDriver(() => deps);
    const runtimeSession = await driver.openLane(baseCtx());
    const received: any[] = [];
    runtimeSession.on("runtime_event", (event) => received.push(event));
    const notify = deps.session.subscribe.mock.calls[0][0];

    const firstOwner = driver.beginTurn();
    await runtimeSession.send({ text: "same", mode: "idle", terminalOwner: firstOwner });
    notify({ type: "agent_end", messages: [] });
    prompts[0]!.resolve();
    await prompts[0]!.promise;
    await Promise.resolve();
    const secondOwner = driver.beginTurn();
    await runtimeSession.send({ text: "same", mode: "idle", terminalOwner: secondOwner });
    notify({ type: "agent_end", messages: [] });
    notify({ type: "agent_end", messages: [] });
    prompts[1]!.resolve();
    await prompts[1]!.promise;
    await Promise.resolve();

    expect(received.filter((event) => event.kind === "turn_end").map((event) => event.turnOwner)).toEqual([
      firstOwner,
      secondOwner,
    ]);
    expect(deps.session.prompt.mock.calls).toEqual([["same"], ["same"]]);
  });
});

describe("PiDriver persistent RuntimeLane contract", () => {
  it("keeps one vendor session across ten owned prompts, busy steer, interrupt, and stop", async () => {
    const deps = fakeDeps();
    const promptResolutions: Array<() => void> = [];
    deps.session.prompt.mockImplementation(() => new Promise<void>((resolve) => {
      promptResolutions.push(resolve);
    }));
    const driver = new PiDriver(() => deps);
    const beginTurn = vi.spyOn(driver, "beginTurn");
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "pi",
      contractVersion: 1,
      capabilities: capabilitiesFor("pi"),
      createAdapter: () => driver,
    }]);
    const sdk = createAgentDriverSdkWithRegistry({
      registry,
      host: createFakeAgentDriverHost(),
    });
    const opened = await sdk.open({
      backend: "pi",
      config: { model: { kind: "default" }, provider: { kind: "default" } },
      launch: {
        workingDirectory: tmpDir,
        instructions: { format: "markdown", content: "You are Pi." },
        launchId: "pi-ten-turns",
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);

    const observed: Array<{ readonly type: string; readonly commandIds?: readonly string[] }> = [];
    const collecting = (async () => {
      for await (const event of opened.session.events) observed.push(event);
    })();
    const completedCount = () => observed.filter((event) => event.type === "turn_completed").length;

    expect(await opened.session.start({ id: "root-1", kind: "user", text: "same prompt" }))
      .toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(deps.session.prompt).toHaveBeenCalledTimes(1));
    const notify = deps.session.subscribe.mock.calls[0]![0];

    expect(await opened.session.interrupt({ requestId: "not-streaming", reason: "test" }))
      .toEqual({ status: "not_running" });
    expect(deps.session.abort).not.toHaveBeenCalled();

    deps.session.isStreaming = true;
    expect(await opened.session.send({ id: "busy", kind: "user", text: "busy steer" }))
      .toMatchObject({ status: "accepted", delivery: "steer" });
    expect(deps.session.steer).toHaveBeenCalledWith("busy steer");
    expect(await opened.session.interrupt({ requestId: "streaming", reason: "test" }))
      .toMatchObject({ status: "accepted", requestId: "streaming" });
    expect(deps.session.abort).toHaveBeenCalledTimes(1);
    deps.session.isStreaming = false;

    for (let turn = 1; turn <= 10; turn += 1) {
      if (turn > 1) {
        expect(await opened.session.send({ id: `root-${turn}`, kind: "user", text: "same prompt" }))
          .toMatchObject({ status: "accepted" });
        await vi.waitFor(() => expect(deps.session.prompt).toHaveBeenCalledTimes(turn));
      }
      notify({ type: "agent_end", messages: [] });
      notify({ type: "agent_end", messages: [] });
      await Promise.resolve();
      expect(completedCount()).toBe(turn - 1);
      promptResolutions[turn - 1]!();
      await vi.waitFor(() => expect(completedCount()).toBe(turn));
    }

    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(deps.session.prompt.mock.calls).toEqual(Array.from({ length: 10 }, () => ["same prompt"]));
    expect(deps.session.steer).toHaveBeenCalledTimes(1);
    expect(beginTurn).toHaveBeenCalledTimes(10);
    const owners = beginTurn.mock.results.map((result) => result.value);
    expect(new Set(owners).size).toBe(10);
    expect(observed.flatMap((event) => event.type === "turn_completed" ? [event.commandIds] : []))
      .toEqual([
        ["root-1", "busy"],
        ...Array.from({ length: 9 }, (_, index) => [`root-${index + 2}`]),
      ]);

    expect(await opened.session.stop({ reason: "shutdown", forceAfterMs: 25 }))
      .toMatchObject({ status: "accepted" });
    await opened.session.closed;
    await collecting;
    expect(deps.session.dispose).toHaveBeenCalledTimes(1);
    expect(deps.session.abort).toHaveBeenCalledTimes(1);
  });
});

describe("Pi SDK event-family coverage", () => {
  it("maps every supported family and explicitly no-ops every known unsupported family", () => {
    const state = { sawTextDelta: false };
    const supported = [
      { input: { type: "message_update", delta: { type: "thinking_delta", delta: "t" } }, kind: "thinking" },
      { input: { type: "message_update", delta: { type: "text_delta", delta: "x" } }, kind: "text" },
      { input: { type: "message_update", delta: { type: "error", message: "e" } }, kind: "error" },
      { input: { type: "tool_execution_start", toolName: "bash", args: {} }, kind: "tool_call" },
      { input: { type: "tool_execution_end", toolName: "bash" }, kind: "tool_output" },
      { input: { type: "compaction_start" }, kind: "compaction_started" },
      { input: { type: "compaction_end" }, kind: "compaction_finished" },
    ];
    for (const item of supported) {
      expect(mapPiSdkEvent(item.input, "session", state)[0]?.kind).toBe(item.kind);
    }
    for (const type of PI_IGNORED_EVENT_TYPES) {
      expect(mapPiSdkEvent({ type }, "session", state)).toEqual([]);
    }
  });
});

describe("findPiSessionFile", () => {
  it("matches an entry ending in `_${sessionId}.jsonl`", () => {
    const sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "2026-01-01_someone-else.jsonl"), "");
    fs.writeFileSync(path.join(sessionDir, "2026-05-01_target-id.jsonl"), "");

    expect(findPiSessionFile(sessionDir, "target-id")).toBe(
      path.join(sessionDir, "2026-05-01_target-id.jsonl"),
    );
  });

  it("returns null when no entry matches the id", () => {
    const sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "2026-01-01_someone-else.jsonl"), "");

    expect(findPiSessionFile(sessionDir, "target-id")).toBeNull();
  });

  it("returns null when the session directory is unreadable / missing", () => {
    expect(findPiSessionFile(path.join(tmpDir, "does-not-exist"), "target-id")).toBeNull();
  });
});

describe("resolvePiSdkVersionFromPath — globally-installed pi fallback detection", () => {
  it("finds the SDK version by following the `pi` binary's symlink up to its package.json (simulates npm/Homebrew/pnpm global installs)", () => {
    // Simulate a global install layout:
    //   <root>/lib/node_modules/@earendil-works/pi-coding-agent/{package.json,dist/cli.js}
    //   <root>/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
    const pkgDir = path.join(tmpDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.80.3" }),
    );
    const entryFile = path.join(pkgDir, "dist", "cli.js");
    fs.writeFileSync(entryFile, "#!/usr/bin/env node\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "pi");
    fs.symlinkSync(entryFile, binPath);

    const version = resolvePiSdkVersionFromPath({ which: (cmd) => (cmd === "pi" ? binPath : null) });
    expect(version).toBe("0.80.3");
  });

  it("returns undefined when `pi` is not on PATH", () => {
    const version = resolvePiSdkVersionFromPath({ which: () => null });
    expect(version).toBeUndefined();
  });

  it("returns undefined (does not throw) when the resolved binary isn't part of the pi-coding-agent package", () => {
    const otherDir = path.join(tmpDir, "some-other-tool");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "package.json"), JSON.stringify({ name: "unrelated-tool", version: "1.0.0" }));
    const binPath = path.join(otherDir, "pi");
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n");

    const version = resolvePiSdkVersionFromPath({ which: (cmd) => (cmd === "pi" ? binPath : null) });
    expect(version).toBeUndefined();
  });

  it("returns undefined (does not throw) when the resolved path doesn't exist on disk", () => {
    const version = resolvePiSdkVersionFromPath({ which: () => path.join(tmpDir, "nonexistent", "pi") });
    expect(version).toBeUndefined();
  });

  // Regression test: on Windows, npm writes the `.cmd` shim as a real file
  // directly in the global prefix root (e.g. `%AppData%\npm`) — NOT a
  // symlink into the package like POSIX — so `realpathSync` never walks us
  // inside it. The package instead sits in a SIBLING `node_modules` folder
  // at that same level, never an ancestor of the shim's own directory.
  it("finds the SDK version via a sibling node_modules dir (simulates a Windows npm global install, where the shim is a real file next to node_modules, not a symlink into it)", () => {
    // Simulate: %AppData%\npm\pi.cmd (a real file, not a symlink) and
    //           %AppData%\npm\node_modules\@earendil-works\pi-coding-agent\
    const npmRoot = path.join(tmpDir, "AppData", "npm");
    const pkgDir = path.join(npmRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.90.1" }),
    );
    const binPath = path.join(npmRoot, "pi.cmd");
    fs.writeFileSync(binPath, "@echo off\r\n"); // a real file, not a symlink

    const version = resolvePiSdkVersionFromPath({ which: (cmd) => (cmd === "pi" ? binPath : null) });
    expect(version).toBe("0.90.1");
  });

  it("resolvePiSdkPackageDir returns the sibling package dir itself, not the shim's own directory", () => {
    const npmRoot = path.join(tmpDir, "AppData", "npm");
    const pkgDir = path.join(npmRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.90.1" }));
    const binPath = path.join(npmRoot, "pi.cmd");
    fs.writeFileSync(binPath, "@echo off\r\n");

    const dir = resolvePiSdkPackageDir({ which: (cmd) => (cmd === "pi" ? binPath : null) });
    // Compare via realpath — on macOS, tmpdir() itself sits behind a
    // `/var` -> `/private/var` symlink unrelated to the thing under test.
    expect(dir && fs.realpathSync(dir)).toBe(fs.realpathSync(pkgDir));
  });
});
