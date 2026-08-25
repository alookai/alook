import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

const paths = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/alook-test-pid-${process.pid}`;
  return { dir, pidFile: `${dir}/.pids.json` };
});

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: paths.dir,
  PID_FILE: paths.pidFile,
  SERVICE_NAMES: ["web", "emailWorker", "wsDo", "wakeWorker"],
}));

import {
  clearRegistry,
  isAlive,
  readRegistry,
  readRegistryText,
  writeRegistry,
  type ServiceRegistry,
} from "../src/lib/pid.js";

function registry(runId = "run-one"): ServiceRegistry {
  const profile = {
    web: { business: 15210, inspector: 19229 },
    emailWorker: { business: 15211, inspector: 19231 },
    wsDo: { business: 15212, inspector: 19230 },
    wakeWorker: { business: 15213, inspector: 19232 },
  };
  return {
    version: 1,
    runId,
    phase: "starting",
    profile,
    services: {
      web: {
        name: "web",
        authority: { pid: 1234, endpoint: "fixture", token: "secret" },
        childPid: 5678,
        childState: "running",
        businessPort: profile.web.business,
        inspectorPort: profile.web.inspector,
        healthUrl: "http://127.0.0.1:15210/api/health",
        logPath: "/tmp/web.log",
      },
    },
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

describe("service registry", () => {
  beforeEach(() => {
    rmSync(paths.dir, { recursive: true, force: true });
    mkdirSync(paths.dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(paths.dir, { recursive: true, force: true });
  });

  it("returns undefined when absent or malformed", () => {
    expect(readRegistry()).toBeUndefined();
    expect(readRegistryText()).toBeUndefined();
    writeFileSync(paths.pidFile, "not json");
    expect(readRegistry()).toBeUndefined();
    expect(readRegistryText()).toBe("not json");
  });

  it.each([
    null,
    {},
    { ...registry(), version: 2 },
    { ...registry(), phase: "unknown" },
    { ...registry(), profile: { ...registry().profile, web: undefined } },
    { ...registry(), profile: { ...registry().profile, web: { business: 1.5, inspector: 2 } } },
    { ...registry(), services: { web: { ...registry().services.web, name: "wsDo" } } },
    { ...registry(), services: { web: { ...registry().services.web, authority: null } } },
    { ...registry(), services: { web: { ...registry().services.web, authority: { pid: "bad", endpoint: "x", token: "y" } } } },
    { ...registry(), services: { web: { ...registry().services.web, childPid: "bad" } } },
    { ...registry(), services: { web: { ...registry().services.web, businessPort: 999 } } },
    { ...registry(), services: { web: { ...registry().services.web, healthUrl: 1 } } },
  ])("rejects an invalid typed registry %#", (value) => {
    writeFileSync(paths.pidFile, JSON.stringify(value));
    expect(readRegistry()).toBeUndefined();
  });

  it("writes atomically and reads the typed schema with private POSIX permissions", () => {
    const value = registry();
    writeRegistry(value);
    expect(readRegistry()).toEqual(value);
    if (process.platform !== "win32") expect(statSync(paths.pidFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("allows only the same runId to advance registry state", () => {
    const value = registry();
    writeRegistry(value);
    writeRegistry({ ...value, phase: "ready" });
    expect(readRegistry()?.phase).toBe("ready");
    expect(() => writeRegistry(registry("replacement"))).toThrow("refusing to replace service generation");
  });

  it("refuses to overwrite malformed state", () => {
    writeFileSync(paths.pidFile, "{}");
    expect(() => writeRegistry(registry())).toThrow("malformed or unverifiable");
  });

  it("clears only the matching generation", () => {
    writeRegistry(registry());
    expect(clearRegistry("older-run")).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(true);
    expect(clearRegistry("run-one")).toBe(true);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("distinguishes live and nonexistent numeric PIDs without using them as authority", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999999)).toBe(false);
  });
});
