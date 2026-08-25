import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

const fixture = vi.hoisted(() => {
  process.env.ALOOK_APP_LIFECYCLE_STALE_MS = "40";
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/alook-lifecycle-lock-${process.pid}`;
  return {
    dir,
    lock: `${dir}/.lifecycle.lock`,
    recovery: `${dir}/.lifecycle.recovery.lock`,
    control: `${dir}/control`,
    supervisor: `${dir}/service-supervisor.js`,
  };
});

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: fixture.dir,
  LIFECYCLE_LOCK_FILE: fixture.lock,
  LIFECYCLE_RECOVERY_LOCK_FILE: fixture.recovery,
  CONTROL_DIR: fixture.control,
}));

import { acquireLifecycleReservation, releaseLifecycleReservation } from "../src/lib/lifecycle-lock.js";
import { supervisorEntryPath } from "../src/lib/control-authority.js";

beforeAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  mkdirSync(fixture.dir, { recursive: true });
  execFileSync("bun", [
    "build",
    join(appRoot, "src/service-supervisor.ts"),
    "--outfile",
    fixture.supervisor,
    "--target",
    "node",
    "--format",
    "esm",
  ], { cwd: appRoot, stdio: "pipe" });
  process.env.ALOOK_APP_SUPERVISOR_ENTRY = fixture.supervisor;
});

beforeEach(() => {
  for (const file of [fixture.lock, fixture.recovery]) rmSync(file, { force: true });
});

afterAll(() => {
  delete process.env.ALOOK_APP_SUPERVISOR_ENTRY;
  delete process.env.ALOOK_APP_LIFECYCLE_STALE_MS;
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe("exclusive lifecycle reservation", () => {
  it("uses the compiled production supervisor fixture", () => {
    expect(supervisorEntryPath()).toBe(fixture.supervisor);
    expect(existsSync(fixture.supervisor)).toBe(true);
  });
  it("allows exactly one concurrent winner and releases it by private token", async () => {
    const attempts = await Promise.allSettled([
      acquireLifecycleReservation(),
      acquireLifecycleReservation(),
    ]);
    const winners = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLifecycleReservation>>> => result.status === "fulfilled");
    const losers = attempts.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    await releaseLifecycleReservation(winners[0].value);

    const next = await acquireLifecycleReservation();
    await releaseLifecycleReservation(next);
  }, 15_000);

  it("blocks a failed challenge while its token-scoped heartbeat is fresh", async () => {
    const heartbeat = join(fixture.dir, "fresh-heartbeat");
    writeFileSync(heartbeat, String(Date.now()));
    writeFileSync(fixture.lock, JSON.stringify({
      version: 1,
      token: "stale-token",
      createdAt: Date.now(),
      heartbeatPath: heartbeat,
      authority: { pid: process.pid, endpoint: join(fixture.control, "missing.sock"), token: "stale-token" },
    }));
    await expect(acquireLifecycleReservation()).rejects.toThrow("another Alook lifecycle command owns");
  });

  it("recovers an unchanged expired lock even when its numeric PID is live but token endpoint is absent", async () => {
    const heartbeat = join(fixture.dir, "expired-heartbeat");
    writeFileSync(heartbeat, String(Date.now() - 5_000));
    writeFileSync(fixture.lock, JSON.stringify({
      version: 1,
      token: "old-token",
      createdAt: Date.now() - 5_000,
      heartbeatPath: heartbeat,
      authority: { pid: process.pid, endpoint: join(fixture.control, "missing.sock"), token: "old-token" },
    }));
    const reservation = await acquireLifecycleReservation();
    expect(reservation.token).not.toBe("old-token");
    await releaseLifecycleReservation(reservation);
  }, 15_000);

  it("reclaims a recovery lease left by a crashed stale-lock reaper", async () => {
    const heartbeat = join(fixture.dir, "crashed-reaper-heartbeat");
    writeFileSync(heartbeat, String(Date.now() - 5_000));
    writeFileSync(fixture.lock, JSON.stringify({
      version: 1,
      token: "abandoned-owner",
      createdAt: Date.now() - 5_000,
      heartbeatPath: heartbeat,
      authority: { pid: process.pid, endpoint: join(fixture.control, "missing.sock"), token: "abandoned-owner" },
    }));
    writeFileSync(fixture.recovery, JSON.stringify({
      version: 1,
      token: "crashed-reaper",
      createdAt: Date.now() - 5_000,
    }));
    const old = new Date(Date.now() - 5_000);
    utimesSync(fixture.recovery, old, old);

    const reservation = await acquireLifecycleReservation();
    expect(reservation.token).not.toBe("abandoned-owner");
    expect(existsSync(fixture.recovery)).toBe(false);
    await releaseLifecycleReservation(reservation);
  }, 15_000);

  it("does not steal a fresh recovery lease", async () => {
    const heartbeat = join(fixture.dir, "fresh-reaper-main-heartbeat");
    writeFileSync(heartbeat, String(Date.now() - 5_000));
    writeFileSync(fixture.lock, JSON.stringify({
      version: 1,
      token: "abandoned-owner",
      createdAt: Date.now() - 5_000,
      heartbeatPath: heartbeat,
      authority: { pid: process.pid, endpoint: join(fixture.control, "missing.sock"), token: "abandoned-owner" },
    }));
    writeFileSync(fixture.recovery, JSON.stringify({
      version: 1,
      token: "active-reaper",
      createdAt: Date.now() + 5_000,
    }));
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
    expect(JSON.parse(readFileSync(fixture.recovery, "utf8")).token).toBe("active-reaper");
  });

  it("recovers an unchanged malformed sentinel only after its file becomes stale", async () => {
    writeFileSync(fixture.lock, "malformed");
    const old = new Date(Date.now() - 5_000);
    utimesSync(fixture.lock, old, old);
    const reservation = await acquireLifecycleReservation();
    await releaseLifecycleReservation(reservation);
  }, 15_000);
});
