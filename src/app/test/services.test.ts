import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const fixture = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/alook-test-services-${process.pid}`;
  return {
    dir,
    pidFile: `${dir}/.pids.json`,
    requestAuthority: vi.fn(),
    wranglerProcess: vi.fn(() => ({ command: "node", args: ["wrangler"] })),
  };
});

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: fixture.dir,
  PID_FILE: fixture.pidFile,
  SERVICE_NAMES: ["web", "emailWorker", "wsDo", "wakeWorker"],
}));
vi.mock("../src/lib/control-authority.js", () => ({
  createAuthorityToken: vi.fn(() => "token"),
  createControlEndpoint: vi.fn(() => "endpoint"),
  requestAuthority: fixture.requestAuthority,
  supervisorEntryPath: vi.fn(() => "/fixture/supervisor.js"),
}));
vi.mock("../src/lib/wrangler.js", () => ({
  wranglerProcess: fixture.wranglerProcess,
}));

import { clearRegistry, readRegistry, writeRegistry, type ServiceRegistry } from "../src/lib/pid.js";
import {
  createServiceCommand,
  handleMatchesRegistry,
  inspectServices,
  stopServices,
  type OwnedServiceHandle,
} from "../src/lib/services.js";

const names = ["web", "emailWorker", "wsDo", "wakeWorker"] as const;

function registry(runId = "run-one"): ServiceRegistry {
  const profile = {
    web: { business: 45210, inspector: 49229 },
    emailWorker: { business: 45211, inspector: 49231 },
    wsDo: { business: 45212, inspector: 49230 },
    wakeWorker: { business: 45213, inspector: 49232 },
  };
  return {
    version: 1,
    runId,
    phase: "ready",
    profile,
    services: Object.fromEntries(names.map((name, index) => [name, {
      name,
      authority: { pid: 900_000 + index, endpoint: `fixture-${name}`, token: `token-${name}` },
      childPid: 910_000 + index,
      childState: "running",
      businessPort: profile[name].business,
      inspectorPort: profile[name].inspector,
      healthUrl: `http://127.0.0.1:${profile[name].business}${name === "web" ? "/api/health" : "/health"}`,
      logPath: `/tmp/${name}.log`,
    }])) as ServiceRegistry["services"],
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

function matchingStatus(value: ServiceRegistry, token: string) {
  const name = names.find((candidate) => value.services[candidate]?.authority.token === token)!;
  const entry = value.services[name]!;
  return {
    ok: true,
    runId: value.runId,
    service: name,
    supervisorPid: entry.authority.pid,
    childPid: entry.childPid,
    childState: "running" as const,
  };
}

describe("service ownership state", () => {
  beforeEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
    mkdirSync(fixture.dir, { recursive: true });
    fixture.requestAuthority.mockReset();
    fixture.wranglerProcess.mockClear();
  });

  afterEach(() => {
    clearRegistry(readRegistry()?.runId ?? "none");
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("distinguishes no registry from malformed recovery-required state", async () => {
    await expect(inspectServices()).resolves.toEqual({ state: "none" });
    writeFileSync(fixture.pidFile, "{}");
    await expect(inspectServices()).resolves.toMatchObject({ state: "recovery-required" });
  });

  it("passes every service's exact business and inspector ports to Wrangler", () => {
    const value = registry();
    for (const name of names) createServiceCommand(name, value.profile);
    expect(fixture.wranglerProcess).toHaveBeenCalledTimes(4);
    for (const name of names) {
      expect(fixture.wranglerProcess).toHaveBeenCalledWith(expect.arrayContaining([
        "--port",
        String(value.profile[name].business),
        "--inspector-port",
        String(value.profile[name].inspector),
      ]));
    }
  });

  it("reuses only four matching live authorities and the exact profile", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      expect(action).toBe("status");
      return Promise.resolve(matchingStatus(value, token));
    });
    await expect(inspectServices(value.profile)).resolves.toMatchObject({ state: "reusable" });
    const different = structuredClone(value.profile);
    different.web.business += 100;
    await expect(inspectServices(different)).resolves.toMatchObject({ state: "profile-mismatch" });
  });

  it("fails partial-live and starting generations instead of treating any PID as reusable", async () => {
    const value = registry();
    value.phase = "starting";
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }) => {
      if (token === "token-web") return Promise.resolve(matchingStatus(value, token));
      return Promise.reject(new Error("missing private endpoint"));
    });
    await expect(inspectServices(value.profile)).resolves.toMatchObject({ state: "partial" });
  });

  it("classifies a fully dead verified registry as stale", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockRejectedValue(new Error("missing private endpoint"));
    await expect(inspectServices()).resolves.toMatchObject({ state: "stale" });
  });

  it("refuses a mismatched authority, preserves diagnostics, and never requests termination", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      if (action === "terminate") throw new Error("must not terminate");
      return Promise.resolve({ ...matchingStatus(value, token), runId: "replacement" });
    });
    const result = await stopServices();
    expect(result.stopped).toBe(false);
    expect(result.errors.join("\n")).toContain("private authority mismatch");
    expect(fixture.requestAuthority.mock.calls.every((call) => call[1] === "status")).toBe(true);
    expect(readRegistry()?.phase).toBe("recovery-required");
  });

  it("terminates each matching owner and clears only the same runId after eight ports drain", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      const status = matchingStatus(value, token);
      return Promise.resolve(action === "terminate" ? { ...status, childState: "stopped" } : status);
    });
    await expect(stopServices()).resolves.toEqual({ stopped: true, errors: [] });
    expect(fixture.requestAuthority.mock.calls.filter((call) => call[1] === "terminate")).toHaveLength(4);
    expect(readRegistry()).toBeUndefined();
  });

  it("prevents a delayed old handle from matching a replacement generation", () => {
    const value = registry();
    const handle = {
      runId: value.runId,
      profile: value.profile,
      registry: value,
      supervisors: {},
      foreground: false,
    } satisfies OwnedServiceHandle;
    expect(handleMatchesRegistry(handle, value)).toBe(true);
    expect(handleMatchesRegistry(handle, registry("replacement"))).toBe(false);
    const tokenReplacement = structuredClone(value);
    tokenReplacement.services.web!.authority.token = "different";
    expect(handleMatchesRegistry(handle, tokenReplacement)).toBe(false);
  });
});
