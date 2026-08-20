import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("createAgentDriverSdk", () => {
  it("exposes the built-ins with default options", () => {
    expect(createAgentDriverSdk().backendIds).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
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
    const lane = {
      currentSessionId: "fresh-session",
      start: vi.fn(async () => ({ ok: true as const, acceptedAs: "prompt" as const, receipt: "fresh-receipt" })),
      send: vi.fn(async () => ({ ok: true as const, acceptedAs: "prompt" as const, receipt: "fresh-send" })),
      interrupt: vi.fn(async () => false),
      stop: vi.fn(async () => {}),
      on: vi.fn(),
    };
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
