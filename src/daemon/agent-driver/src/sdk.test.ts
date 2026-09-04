import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDriverError,
  BackendTypeSpec,
  BuiltinBackendSpecs,
} from "./index.js";
import type { BackendAdapter } from "./adapter-author.js";
import type { AgentDriverHost } from "./host.js";
import { ClaudeDriver } from "./adapters/claude/index.js";
import { createFakeAgentDriverHost } from "./testing/fake-host.js";
import { createAgentDriverSdk, createAgentDriverSdkWithRegistry } from "./sdk.js";
import { createAgentDriverRegistry, type AgentDriverRegistry } from "./registry.js";
import { createAgentDriverSdk as createPublicAgentDriverSdk } from "./public-sdk.js";
import { SESSION_FILE_DISCOVERY_CAPABILITIES } from "./index.js";

const claudeInput = {
  backend: "claude" as const,
  launch: {
    workingDirectory: process.cwd(),
    instructions: { format: "markdown" as const, content: "" },
    launchId: "launch-1",
  },
  config: {
    model: { kind: "default" as const },
    provider: { kind: "default" as const },
    mode: "default" as const,
  },
};

const claudeCapabilities = {
  modelSelection: "launchable",
  providerConfiguration: true,
  reasoningEffort: true,
  fastMode: true,
  disallowedTools: true,
  commandOverride: true,
  resume: "by_id",
  sessionLifetime: "persistent",
  midTurnDelivery: "safe_boundary_queue",
  interrupt: true,
} as const;

afterEach(() => vi.restoreAllMocks());

function sdkTestLane(receipt = "fresh-receipt") {
  return {
    currentSessionId: "fresh-session",
    start: vi.fn(async () => ({ ok: true as const, acceptedAs: "prompt" as const, receipt })),
    send: vi.fn(async () => ({ ok: true as const, acceptedAs: "prompt" as const, receipt })),
    interrupt: vi.fn(async () => false),
    stop: vi.fn(async () => {}),
    on: vi.fn(),
  };
}

describe("createAgentDriverSdk", () => {
  it("exposes the built-ins with default options", () => {
    expect(createAgentDriverSdk().backendIds).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
    expect(SESSION_FILE_DISCOVERY_CAPABILITIES).toEqual(["supported", "unavailable"]);
  });

  it("maps healthy, unhealthy, and thrown adapter probes", async () => {
    const sdk = createAgentDriverSdk();
    const probe = vi.spyOn(ClaudeDriver.prototype, "probe");
    probe.mockResolvedValueOnce({ status: "healthy", version: "1.2.3" });
    await expect(sdk.probe({ backend: "claude", command: "claude-test" })).resolves.toMatchObject({
      status: "healthy",
      version: "1.2.3",
    });

    probe.mockResolvedValueOnce({ status: "unhealthy", lastError: "not_found" });
    await expect(sdk.probe({ backend: "claude" })).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "not_found" },
    });

    probe.mockRejectedValueOnce(new Error("probe exploded"));
    await expect(sdk.probe({ backend: "claude" })).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "probe_threw", message: "Backend claude probe failed" },
    });
  });

  it.each(["claude", "codex", "cursor", "opencode"] as const)(
    "forwards an explicit command override through the real %s probe",
    async (backend) => {
      await expect(createAgentDriverSdk().probe({ backend, command: process.execPath })).resolves.toMatchObject({
        status: "healthy",
      });
    },
  );

  it("public SDK factory delegates to the built-in logical SDK", () => {
    expect(createPublicAgentDriverSdk().backendIds).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
  });

  it.each(["claude", "codex", "cursor", "opencode", "pi"] as const)(
    "dispatches zero-bound discovery through the built-in %s adapter",
    async (backend) => {
      await expect(createAgentDriverSdk().discoverRecentContext({
        backend,
        recentSessionFilesTopK: 0,
        recentProjectsTopK: 0,
      })).resolves.toEqual({
        ok: true,
        sessionFiles: {
          capability: backend === "cursor" || backend === "opencode" ? "unavailable" : "supported",
          items: [],
        },
        recentProjects: [],
      });
    },
  );

  it("validates independent Top-K values and dispatches discovery without leaking thrown details", async () => {
    const sdk = createAgentDriverSdk();
    const discover = vi.spyOn(ClaudeDriver.prototype, "discoverRecentContext");
    const projectPath = join(process.cwd(), "projects", "a");
    await expect(sdk.discoverRecentContext({
      backend: "claude",
      recentSessionFilesTopK: -1,
      recentProjectsTopK: 2,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_recent_context_top_k", retryable: false },
    });
    expect(discover).not.toHaveBeenCalled();

    discover.mockResolvedValueOnce({
      sessionFiles: { capability: "supported", items: [] },
      recentProjects: [{ projectPath, modifiedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await expect(sdk.discoverRecentContext({
      backend: "claude",
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
      command: "claude-test",
    })).resolves.toEqual({
      ok: true,
      sessionFiles: { capability: "supported", items: [] },
      recentProjects: [{ projectPath, modifiedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(discover).toHaveBeenCalledWith({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
      command: "claude-test",
    });

    discover.mockRejectedValueOnce(new Error("private /Users/person/session.jsonl"));
    await expect(sdk.discoverRecentContext({
      backend: "claude",
      recentSessionFilesTopK: 1,
      recentProjectsTopK: 1,
    })).resolves.toEqual({
      ok: false,
      error: {
        category: "runtime_unavailable",
        code: "recent_context_discovery_failed",
        message: "Backend claude recent-context discovery failed",
        retryable: true,
      },
    });
  });

  it("returns host preparation failures without constructing a session", async () => {
    const error: AgentDriverError = {
      category: "configuration",
      code: "prepare_failed",
      message: "cannot prepare",
      retryable: false,
    };
    const host = {
      prepareExecution: vi.fn(async () => ({ ok: false as const, error })),
      onRawOutput: vi.fn(),
      now: () => 1,
      createId: () => "id",
    } satisfies AgentDriverHost;
    await expect(createAgentDriverSdk({ host }).open(claudeInput)).resolves.toEqual({ ok: false, error });
  });

  it("opens a logical session using the prepared host resource", async () => {
    const host = createFakeAgentDriverHost();
    const opened = await createAgentDriverSdk({ host, hostReleaseTimeoutMs: 25 }).open(claudeInput);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected a session");
    expect(opened.capabilities.midTurnDelivery).toBe("safe_boundary_queue");
    expect(opened.session.snapshot()).toMatchObject({ state: "new", queuedCommands: [] });
    await opened.session.stop({ reason: "shutdown", forceAfterMs: 1 });
    expect(host.releases).toHaveLength(1);
  });

  it("creates a fresh workspace before public instruction materialization and lane open", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-driver-fresh-workspace-"));
    const workingDirectory = join(base, "nested", "agent");
    const host = createFakeAgentDriverHost();
    const adapter = new ClaudeDriver();
    vi.spyOn(adapter, "beginTurn").mockReturnValue("fresh-receipt");
    const lane = sdkTestLane();
    const openLane = vi.spyOn(adapter, "openLane").mockImplementation(async (ctx) => {
      expect(ctx.workingDirectory).toBe(workingDirectory);
      expect(readFileSync(join(workingDirectory, "AGENTS.md"), "utf8")).toBe("Fresh instructions.");
      expect(readFileSync(join(workingDirectory, "CLAUDE.md"), "utf8")).toBe("Fresh instructions.");
      return lane;
    });
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);

    try {
      const opened = await createAgentDriverSdkWithRegistry({ registry, host }).open({
        ...claudeInput,
        launch: {
          ...claudeInput.launch,
          workingDirectory,
          instructions: { format: "markdown", content: "Fresh instructions." },
        },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("expected a session");
      await expect(opened.session.start({ id: "fresh", kind: "user", text: "hello" }))
        .resolves.toMatchObject({ status: "accepted" });
      expect(openLane).toHaveBeenCalledTimes(1);
      await opened.session.stop({ reason: "shutdown", forceAfterMs: 1 });
      expect(lane.stop).toHaveBeenCalledTimes(1);
      expect(host.releases).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("creates a fresh workspace for empty instructions before lane open", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-driver-empty-workspace-"));
    const workingDirectory = join(base, "nested", "agent");
    const host = createFakeAgentDriverHost();
    const adapter = new ClaudeDriver();
    vi.spyOn(adapter, "beginTurn").mockReturnValue("fresh-receipt");
    const lane = sdkTestLane();
    const openLane = vi.spyOn(adapter, "openLane").mockImplementation(async () => {
      expect(existsSync(workingDirectory)).toBe(true);
      return lane;
    });
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);

    try {
      const opened = await createAgentDriverSdkWithRegistry({ registry, host }).open({
        ...claudeInput,
        launch: { ...claudeInput.launch, workingDirectory },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("expected a session");
      await expect(opened.session.start({ id: "fresh-empty", kind: "user", text: "hello" }))
        .resolves.toMatchObject({ status: "accepted" });
      expect(openLane).toHaveBeenCalledTimes(1);
      await opened.session.stop({ reason: "shutdown", forceAfterMs: 1 });
      expect(host.releases).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves existing workspace content while materializing instructions", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-existing-workspace-"));
    const marker = join(workingDirectory, "keep.txt");
    writeFileSync(marker, "keep me");
    const host = createFakeAgentDriverHost();
    const adapter = new ClaudeDriver();
    vi.spyOn(adapter, "beginTurn").mockReturnValue("fresh-receipt");
    const lane = sdkTestLane();
    vi.spyOn(adapter, "openLane").mockResolvedValue(lane);
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);

    try {
      const opened = await createAgentDriverSdkWithRegistry({ registry, host }).open({
        ...claudeInput,
        launch: {
          ...claudeInput.launch,
          workingDirectory,
          instructions: { format: "markdown", content: "Existing workspace instructions." },
        },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("expected a session");
      await expect(opened.session.start({ id: "existing", kind: "user", text: "hello" }))
        .resolves.toMatchObject({ status: "accepted" });
      expect(readFileSync(marker, "utf8")).toBe("keep me");
      await opened.session.stop({ reason: "shutdown", forceAfterMs: 1 });
      expect(host.releases).toHaveLength(1);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed before physical lane open when the workspace path is not a directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-driver-invalid-workspace-"));
    const workingDirectory = join(base, "not-a-directory");
    writeFileSync(workingDirectory, "occupied");
    const host = createFakeAgentDriverHost();
    const adapter = new ClaudeDriver();
    const openLane = vi.spyOn(adapter, "openLane").mockResolvedValue(sdkTestLane());
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);

    try {
      const opened = await createAgentDriverSdkWithRegistry({ registry, host }).open({
        ...claudeInput,
        launch: {
          ...claudeInput.launch,
          workingDirectory,
          instructions: { format: "markdown", content: "Cannot be written." },
        },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("expected a session");
      const eventTypes = (async () => {
        const types: string[] = [];
        for await (const event of opened.session.events) types.push(event.type);
        return types;
      })();
      await expect(opened.session.start({ id: "blocked", kind: "user", text: "hello" }))
        .resolves.toMatchObject({ status: "rejected", reason: "runtime_unavailable" });
      await expect(opened.session.closed).resolves.toMatchObject({ outcome: "failed_to_start" });
      expect(await eventTypes).not.toContain("session_started");
      expect(openLane).not.toHaveBeenCalled();
      expect(opened.session.snapshot().diagnostics.metrics.physicalOpenCount).toBe(0);
      expect(host.releases).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("opens a sixth backend through only its public adapter registration", async () => {
    const capabilities = {
      modelSelection: "unsupported",
      providerConfiguration: false,
      reasoningEffort: false,
      fastMode: false,
      disallowedTools: false,
      commandOverride: false,
      resume: "none",
      sessionLifetime: "per_turn",
      midTurnDelivery: "next_turn_queue",
      interrupt: false,
    } as const;
    interface SixthSpecs {
      readonly sixth: BackendTypeSpec<
        { readonly flavor: string },
        typeof capabilities,
        Record<never, never>,
        never
      >;
    }
    const adapter: BackendAdapter<"sixth", { readonly flavor: string }> = {
      id: "sixth",
      instructionDelivery: { kind: "native" },
      execution: {
        lifetime: "turn",
        transport: { kind: "one_shot_cli", protocol: "sixth.test.v1" },
        wakeStart: "deferred",
        terminalOwnership: "lane_generation",
      },
      probe: vi.fn(() => ({ status: "healthy" as const, version: "6.0.0" })),
      openLane: vi.fn(async () => { throw new Error("not started by this test"); }),
    };
    const registry = createAgentDriverRegistry<SixthSpecs>([{
      id: "sixth",
      contractVersion: 1,
      capabilities,
      createAdapter: () => adapter,
    }]);
    const sdk = createAgentDriverSdkWithRegistry({ registry, host: createFakeAgentDriverHost() });

    expect(sdk.backendIds).toEqual(["sixth"]);
    await expect(sdk.probe({ backend: "sixth" })).resolves.toMatchObject({
      status: "healthy",
      version: "6.0.0",
      capabilities,
    });
    await expect(sdk.discoverRecentContext({
      backend: "sixth",
      recentSessionFilesTopK: 1,
      recentProjectsTopK: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "recent_context_discovery_unsupported", retryable: false },
    });
    const opened = await sdk.open({
      backend: "sixth",
      launch: {
        workingDirectory: process.cwd(),
        instructions: { format: "markdown", content: "native instructions" },
        launchId: "sixth-launch",
      },
      config: { flavor: "vanilla" },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.session.backend).toBe("sixth");
    await opened.session.stop({ reason: "shutdown", forceAfterMs: 1 });
  });

  it("fails adapter identity validation before host preparation", async () => {
    const host = createFakeAgentDriverHost();
    const prepare = vi.spyOn(host, "prepareExecution");
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => {
        const adapter = new ClaudeDriver();
        Object.defineProperty(adapter, "id", { value: "codex" });
        return adapter;
      },
    }]);
    const sdk = createAgentDriverSdkWithRegistry({ registry, host });

    await expect(sdk.probe({ backend: "claude" })).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    await expect(sdk.open(claudeInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reports a malformed optional recent-context hook as an adapter contract error", async () => {
    const adapter = new ClaudeDriver();
    Object.defineProperty(adapter, "discoverRecentContext", {
      configurable: true,
      value: "not-a-function",
    });
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);
    const sdk = createAgentDriverSdkWithRegistry({ registry, host: createFakeAgentDriverHost() });

    await expect(sdk.discoverRecentContext({
      backend: "claude",
      recentSessionFilesTopK: 1,
      recentProjectsTopK: 1,
    })).resolves.toEqual({
      ok: false,
      error: {
        category: "internal",
        code: "adapter_contract_invalid",
        message: "Backend claude adapter contract is invalid",
        retryable: false,
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["old", 0],
    ["unknown", 2],
  ] as const)("fails a %s contract version from an untrusted custom registry before side effects", async (_name, version) => {
    const host = createFakeAgentDriverHost();
    const prepare = vi.spyOn(host, "prepareExecution");
    const createAdapter = vi.fn(() => new ClaudeDriver());
    const registry = {
      backendIds: ["claude"],
      get: () => ({
        id: "claude",
        contractVersion: version,
        capabilities: claudeCapabilities,
        createAdapter,
      }),
    } as unknown as AgentDriverRegistry<BuiltinBackendSpecs>;
    const sdk = createAgentDriverSdkWithRegistry({ registry, host });

    await expect(sdk.probe({ backend: "claude" })).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    await expect(sdk.open(claudeInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    expect(createAdapter).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("accepts an opaque third-party transport kind without protocol-name branching", async () => {
    const adapter = new ClaudeDriver();
    Object.defineProperty(adapter, "execution", {
      configurable: true,
      value: {
        lifetime: "session",
        transport: {
          kind: "websocket_multiplex",
          protocol: "third-party.example.v7",
          metadata: { framing: "binary" },
        },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
      },
    });
    vi.spyOn(adapter, "probe").mockReturnValue({ status: "healthy", version: "7.0.0" });
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => adapter,
    }]);

    await expect(createAgentDriverSdkWithRegistry({ registry }).probe({ backend: "claude" }))
      .resolves.toMatchObject({ status: "healthy", version: "7.0.0" });
  });

  it.each([
    ["missing probe", { probe: undefined }],
    ["invalid instruction kind", { instructionDelivery: { kind: "raw" } }],
    ["incomplete execution", { execution: {
      lifetime: "session", transport: { kind: "stdio_stream", protocol: "claude.test.v1" }, wakeStart: "unknown",
      terminalOwnership: "vendor_message",
    } }],
    ["invalid execution kind", { execution: { lifetime: "raw" } }],
    ["invalid transport", { execution: {
      lifetime: "session", transport: { kind: "stdio_stream", protocol: "" }, wakeStart: "immediate",
      terminalOwnership: "vendor_message",
    } }],
    ["lifetime mismatch", { execution: {
      lifetime: "turn", transport: { kind: "one_shot_cli", protocol: "claude.test.v1" }, wakeStart: "immediate",
      terminalOwnership: "lane_generation",
    } }],
    ["deferred persistent wake", { execution: {
      lifetime: "session", transport: { kind: "stdio_stream", protocol: "claude.test.v1" }, wakeStart: "deferred",
      terminalOwnership: "vendor_message",
    } }],
    ["invalid workspace instruction", {
      instructionDelivery: { kind: "workspace_file", canonical: "", aliases: [1] },
    }],
    ["missing lane factory", { openLane: undefined }],
  ] as const)("fails %s adapter shape validation before host preparation", async (_name, override) => {
    const host = createFakeAgentDriverHost();
    const prepare = vi.spyOn(host, "prepareExecution");
    const valid = new ClaudeDriver();
    const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
      id: "claude",
      contractVersion: 1,
      capabilities: claudeCapabilities,
      createAdapter: () => {
        for (const [key, value] of Object.entries(override)) {
          Object.defineProperty(valid, key, { configurable: true, value });
        }
        return valid as never;
      },
    }]);
    const sdk = createAgentDriverSdkWithRegistry({ registry, host });

    await expect(sdk.probe({ backend: "claude" })).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    await expect(sdk.open(claudeInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "adapter_contract_invalid", retryable: false },
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
