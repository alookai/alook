import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { daemonStop } from "./daemonStart";

/**
 * daemonStop went from spinning (`while (Date.now() - start < 100) {}` busy
 * loop) to async setTimeout polling. This test asserts the *behavior* — a
 * live child receives SIGTERM and exits inside the grace window — and, as a
 * side effect, that the function actually awaits (it returns a Promise now).
 */
describe("daemonStop — event-loop friendly (no spin loop)", () => {
  let baseDir: string;
  let pidfile: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemonstop-"));
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("SIGTERMs the daemon and cleans up the pidfile once it exits", async () => {
    // Spawn a real child so we can send SIGTERM at it. `node -e` picks the
    // ambient node binary — no PATH assumptions.
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });

    // Track the child's actual termination via its own `exit` event. daemonStop
    // kills by raw pid (process.kill), NOT via this ChildProcess handle, so
    // `child.killed` stays false and `exitCode`/`signalCode` are only populated
    // once Node delivers the exit event — which does not happen synchronously
    // when daemonStop resolves (this is why the old assertion flaked on Windows,
    // where the event lags behind the OS process actually being gone).
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const id = "cm_abc123def456";
    const daemonsDir = path.join(baseDir, "daemons");
    // Per-key subdir layout (C0): pidfile is daemons/<id>/daemon.pid.
    fs.mkdirSync(path.join(daemonsDir, id), { recursive: true });
    pidfile = path.join(daemonsDir, id, "daemon.pid");
    fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, key: "cmk_test_key" }));

    const stopPromise = daemonStop({ id, baseDir });
    expect(stopPromise).toBeInstanceOf(Promise);
    await stopPromise;

    expect(fs.existsSync(pidfile)).toBe(false);
    // Wait for the child's exit event to land (daemonStop already SIGKILL-escalates
    // within its grace window, so this resolves well inside the test timeout).
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);

  it("stops by ID (the pidfile name shown in `daemon list`) — no machine key needed (C3)", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const machineKey = "cmk_secret_should_not_be_needed";
    const daemonsDir = path.join(baseDir, "daemons");
    const crypto = await import("crypto");
    const id = crypto.createHash("sha256").update(machineKey).digest("hex").slice(0, 12);
    // Per-key subdir (C0): daemons/<id>/daemon.pid — id is the subdir name.
    fs.mkdirSync(path.join(daemonsDir, id), { recursive: true });
    pidfile = path.join(daemonsDir, id, "daemon.pid");
    fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, key: machineKey }));

    // Stop using ONLY the id (what `daemon list` shows) — the credential
    // (machineKey) never enters the call. This is the C3 compose: list shows id,
    // stop eats id.
    await daemonStop({ id, baseDir });

    expect(fs.existsSync(pidfile)).toBe(false); // same SIGTERM→cleanup semantic
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);

  it("keeps ownership through SIGKILL until a SIGTERM-ignoring process is dead", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const id = "cm_sigkill_test_1";
    const dir = path.join(baseDir, "daemons", id);
    fs.mkdirSync(dir, { recursive: true });
    pidfile = path.join(dir, "daemon.pid");
    fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, key: "cmk_test_key" }));

    await daemonStop({ id, baseDir });

    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(fs.existsSync(pidfile)).toBe(false);
    await exited;
  }, 15_000);

  it("stop with an unknown id is a no-op (no throw), points at `daemon list`", async () => {
    // No pidfile for this id → graceful message, no crash.
    await expect(daemonStop({ id: "deadbeef0000", baseDir })).resolves.toBeUndefined();
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "cm_bad\\segment",
    `cm_${"a".repeat(65)}`,
  ])("rejects an unsafe id before resolving a pidfile: %s", async (id) => {
    await expect(daemonStop({ id, baseDir })).rejects.toThrow("invalid daemon id");
  });

  it("does not read or signal a pid from a traversal-selected pidfile", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
    const outsideName = `${path.basename(baseDir)}-outside`;
    const outsideDir = path.join(path.dirname(baseDir), outsideName);
    const outsidePidfile = path.join(outsideDir, "daemon.pid");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsidePidfile, JSON.stringify({ pid: child.pid, key: "cmk_outside" }));
    try {
      await expect(daemonStop({ id: `../../${outsideName}`, baseDir })).rejects.toThrow("invalid daemon id");
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(fs.readFileSync(outsidePidfile, "utf8")).toContain("cmk_outside");
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
