import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PiDriver, resolvePiSdkVersionFromPath, resolvePiSdkPackageDir, findPiSessionFile } from "./pi";
import { CANONICAL_FILE } from "./agentFile";
import type { LaunchContext } from "../types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-driver-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseCtx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    agentId: "agent_1",
    workingDirectory: tmpDir,
    standingPrompt: "You are Pi.",
    prompt: "hello",
    config: {},
    credentialProxy: {} as LaunchContext["credentialProxy"],
    ...overrides,
  };
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

describe("PiDriver.createSession — AGENTS.md packing", () => {
  it("does not write AGENTS.md itself — prepareCliTransport (inside piSdkDeps.buildSpawnEnv) is the single packing point", async () => {
    const driver = new PiDriver();
    const deps = fakeDeps();

    await driver.createSession(baseCtx(), deps);

    // The driver no longer writes AGENTS.md — buildSpawnEnv already did, and
    // duplicating the write here would risk hash-dedup drift.
    expect(fs.existsSync(path.join(tmpDir, CANONICAL_FILE))).toBe(false);

    const sessionOpts = deps.createAgentSession.mock.calls[0][0];
    expect(sessionOpts).not.toHaveProperty("standingPrompt");
  });
});

describe("PiDriver.createSession — does not fire the initial prompt itself", () => {
  it("returns without calling session.prompt — the caller (SdkManagedSession) sends the first turn", async () => {
    const driver = new PiDriver();
    const deps = fakeDeps();

    const runtimeSession = await driver.createSession(baseCtx(), deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(runtimeSession.currentSessionId).toBe("sess_1");
  });

  it("wires session.subscribe before returning, so events fired by a later prompt() call are not lost", async () => {
    const driver = new PiDriver();
    const deps = fakeDeps();

    const runtimeSession = await driver.createSession(baseCtx(), deps);
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
