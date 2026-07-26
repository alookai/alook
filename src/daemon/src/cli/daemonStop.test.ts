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
    const machineKey = "cmk_test_key";
    const daemonsDir = path.join(baseDir, "daemons");
    fs.mkdirSync(daemonsDir, { recursive: true });
    // pidfile name is <sha256(machineKey).slice(0,12)>.pid — we don't care
    // about the exact hash here; just create one that daemonStop will find
    // by re-computing the same hash.
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(machineKey).digest("hex").slice(0, 12);
    pidfile = path.join(daemonsDir, `${hash}.pid`);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, key: machineKey }));

    const stopPromise = daemonStop({ machineKey, baseDir });
    expect(stopPromise).toBeInstanceOf(Promise);
    await stopPromise;

    expect(fs.existsSync(pidfile)).toBe(false);
    // The child should have received the SIGTERM — Node's own exit signal
    // handling terminates cleanly on SIGTERM.
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);
});
