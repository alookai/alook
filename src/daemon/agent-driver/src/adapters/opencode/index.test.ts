import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLaunchContext, fakePrepared } from "../../testing/adapter-fixture.js";
import { OpenCodeDriver } from "./index.js";
import { resolveOpenCodeCompatibility } from "./compatibility.js";
import * as recentContext from "./recent-context.js";
import { OpenCodeV2ServiceLane } from "./v2-service-lane.js";

const spawnAgentProcess = vi.hoisted(() => vi.fn());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  spawnAgentProcess,
  killProcessTree: vi.fn(async () => {}),
}));

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCodeDriver persistent v2 service", () => {
  let driver: OpenCodeDriver;

  beforeEach(() => {
    spawnAgentProcess.mockClear();
    driver = new OpenCodeDriver(undefined, () => ({ status: "healthy", version: "1.18.35" }));
  });

  it("keeps empty discovery available when the configured CLI is unavailable", async () => {
    const version = vi.fn(() => ({ status: "unhealthy" as const, lastError: "not_found" }));
    const driver = new OpenCodeDriver(undefined, version);
    await expect(driver.discoverRecentContext({ recentSessionFilesTopK: 2, recentProjectsTopK: 0 })).resolves.toEqual({
      sessionFiles: { capability: "unavailable", items: [] }, recentProjects: [],
    });
    expect(version).not.toHaveBeenCalled();
    expect(driver.probe()).toMatchObject({ status: "unhealthy", lastError: "not_found" });
    expect(() => driver.discoverRecentContext({ recentSessionFilesTopK: 0, recentProjectsTopK: 1 })).toThrow("could not report its version");
    await expect(driver.openLane(fakeLaunchContext("opencode", "/tmp"))).rejects.toThrow("could not report its version");
  });

  it("dispatches recent projects with the actual override's CLI compatibility", async () => {
    const discover = vi.spyOn(recentContext, "discoverOpenCodeRecentContext").mockResolvedValue({
      sessionFiles: { capability: "unavailable", items: [] }, recentProjects: [],
    });
    const driver = new OpenCodeDriver(undefined, () => ({ status: "healthy", version: "2.0.28" }));
    const request = { command: "opencode-custom", recentSessionFilesTopK: 0, recentProjectsTopK: 1 };
    await driver.discoverRecentContext(request);
    expect(discover).toHaveBeenCalledWith(request, { compatibility: resolveOpenCodeCompatibility("2.0.28") });
  });

  it("checks native compatibility without querying models", () => {
    const output = vi.fn();
    expect(new OpenCodeDriver(output, () => ({ status: "healthy", version: "2.0.28" })).probe("native", false)).toMatchObject({ status: "healthy", version: "2.0.28" });
    expect(output).not.toHaveBeenCalled();
    expect(new OpenCodeDriver(output, () => ({ status: "healthy", version: "9.0.0" })).probe("native", false)).toMatchObject({ status: "unhealthy", lastError: "unsupported_opencode_cli_version" });
  });

  it("uses models --pure output for a non-fatal startup catalog", () => {
    const outputProbe = vi.fn(() => ({
      ok: true as const,
      output: "openai/gpt-5\nanthropic/claude-sonnet\n",
    }));
    const result = new OpenCodeDriver(outputProbe, () => ({ status: "healthy", version: "1.18.35" })).probe(process.execPath);

    expect(outputProbe).toHaveBeenCalledWith(process.execPath, ["models", "--pure"]);
    expect(result).toMatchObject({
      status: "healthy",
      reasoning: {
        models: [
          { id: "openai/gpt-5", supportedReasoningEfforts: [] },
          { id: "anthropic/claude-sonnet", supportedReasoningEfforts: [] },
        ],
      },
    });
  });

  it("probes the configured CLI major and uses its model catalog arguments", () => {
    const output = vi.fn(() => ({ ok: true as const, output: "opencode/space-bunny-free\n" }));
    const version = vi.fn(() => ({ status: "healthy" as const, version: "opencode v2.0.28" }));
    const result = new OpenCodeDriver(output, version).probe("opencode-v2-custom");
    expect(version).toHaveBeenCalledWith("opencode", {}, "opencode-v2-custom");
    expect(output).toHaveBeenCalledWith("opencode-v2-custom", ["models", "--standalone"]);
    expect(result.status).toBe("healthy");
  });

  it("rejects an unknown CLI major before catalog or service startup", async () => {
    const output = vi.fn();
    const unknown = new OpenCodeDriver(output, () => ({ status: "healthy", version: "3.0.0" }));
    expect(unknown.probe()).toMatchObject({ status: "unhealthy", lastError: "unsupported_opencode_cli_version" });
    await expect(unknown.openLane(fakeLaunchContext("opencode", "/tmp"))).rejects.toThrow("unsupported major");
    expect(output).not.toHaveBeenCalled();
    expect(spawnAgentProcess).not.toHaveBeenCalled();
  });

  it("selects the CLI v2 lane from the actual command override", async () => {
    const version = vi.fn(() => ({ status: "healthy" as const, version: "2.0.28" }));
    const lane = await new OpenCodeDriver(undefined, version).openLane(fakeLaunchContext("opencode", "/tmp", {
      config: { runtimeConfig: { command: "opencode-v2-custom", model: { kind: "default" } } },
    }));
    expect(version).toHaveBeenCalledWith("opencode", {}, "opencode-v2-custom");
    expect(lane).toBeInstanceOf(OpenCodeV2ServiceLane);
    expect(spawnAgentProcess).not.toHaveBeenCalled();
  });

  it("fixes the selected CLI profile for the lane even when a later probe changes", async () => {
    const version = vi.fn().mockReturnValueOnce({ status: "healthy", version: "2.0.28" }).mockReturnValue({ status: "healthy", version: "1.18.35" });
    const driver = new OpenCodeDriver(() => ({ ok: false, error: "unavailable" }), version);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: "3.0.0", pid: 42_999 })));
    const lane = await driver.openLane(fakeLaunchContext("opencode", "/tmp"));
    driver.probe();
    spawnAgentProcess.mockReturnValue(Object.assign(new EventEmitter(), { pid: 42_999, stdout: null, stderr: null, stdin: null, exitCode: null, signalCode: null, kill: vi.fn() }));
    expect(await lane.start({ text: "one", terminalOwner: "msg_root" })).toMatchObject({ ok: false, reason: "incompatible_configuration" });
    expect(spawnAgentProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["serve", "--hostname"]));
    expect(spawnAgentProcess.mock.calls[0]?.[1]).not.toContain("--pure");
  });

  it("protects CLI v2 service authentication without passing legacy flags", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-v2-spawn-")); directories.push(directory);
    await driver.spawnService(fakeLaunchContext("opencode", directory), 43123, "session-secret", resolveOpenCodeCompatibility("2.0.28"));
    const [, args, options] = spawnAgentProcess.mock.calls[0]!;
    expect(args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "43123"]);
    expect(options.env.OPENCODE_PASSWORD).toBe("session-secret");
    expect(JSON.stringify(args)).not.toContain("session-secret");
  });

  it("keeps runtime health healthy when models --pure fails", () => {
    expect(new OpenCodeDriver(() => ({ ok: false, error: "ETIMEDOUT" }), () => ({ status: "healthy", version: "1.18.35" })).probe(process.execPath))
      .toMatchObject({ status: "healthy", reasoning: undefined });
  });

  it("declares persistent HTTP/SSE steering with transport-owned terminal receipts", () => {
    expect(driver.execution).toEqual({
      lifetime: "session",
      transport: { kind: "http_sse", protocol: "opencode.v2.service" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    });
    expect("normalizeLine" in driver).toBe(false);
  });

  it("creates opaque caller message ids for root ownership", () => {
    const first = driver.beginTurn();
    const second = driver.beginTurn();
    expect(first).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(second).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it("opens a persistent service lane without spawning before start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-lane-"));
    directories.push(directory);
    await expect(driver.openLane(fakeLaunchContext("opencode", directory))).resolves.toMatchObject({
      currentSessionId: null,
    });
    expect(spawnAgentProcess).not.toHaveBeenCalled();
  });

  it("uses the selected legacy API credential for the native v2 provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-legacy-auth-"));
    directories.push(directory);
    const data = join(directory, "data");
    const cache = join(directory, "cache");
    mkdirSync(join(data, "opencode"), { recursive: true });
    mkdirSync(join(cache, "opencode"), { recursive: true });
    writeFileSync(join(data, "opencode", "auth.json"), JSON.stringify({
      deepseek: { type: "api", key: "isolated-deepseek-key" },
      unrelated: { type: "api", key: "must-not-escape" },
    }));
    writeFileSync(join(cache, "opencode", "models.json"), JSON.stringify({
      deepseek: { env: ["DEEPSEEK_API_KEY"] }, unrelated: { env: ["OTHER_API_KEY"] },
    }));
    await driver.spawnService(fakeLaunchContext("opencode", directory, {
      prepared: fakePrepared({ base: { XDG_DATA_HOME: data, XDG_CACHE_HOME: cache } }),
      config: { runtimeConfig: { model: { kind: "named", name: "deepseek/deepseek-flash" } } },
    }), 43123, "session-secret");
    const [, args, options] = spawnAgentProcess.mock.calls.at(-1)!;
    expect(options.env.DEEPSEEK_API_KEY).toBe("isolated-deepseek-key");
    expect(options.env.OTHER_API_KEY).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain("isolated-deepseek-key");
  });

  it("spawns one loopback service without putting its password in argv", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-driver-"));
    directories.push(directory);
    const process = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: null,
      stderr: null,
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    spawnAgentProcess.mockReturnValue(process);

    await driver.spawnService(fakeLaunchContext("opencode", directory, {
      config: { runtimeConfig: { model: { kind: "default" }, command: "opencode-custom" } },
    }), 43123, "session-secret");

    expect(spawnAgentProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnAgentProcess.mock.calls[0]!;
    expect(command).toBe("opencode-custom");
    expect(args).toEqual(["serve", "--pure", "--hostname", "127.0.0.1", "--port", "43123"]);
    expect(JSON.stringify(args)).not.toContain("session-secret");
    expect(options).toMatchObject({
      cwd: directory,
      env: { OPENCODE_SERVER_PASSWORD: "session-secret" },
    });
  });
});
