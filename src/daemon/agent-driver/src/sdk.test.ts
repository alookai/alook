import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDriverHost,
  AgentDriverError,
  BackendAdapter,
  BackendTypeSpec,
} from "./index.js";
import { ClaudeDriver } from "./adapters/claude/index.js";
import { createFakeAgentDriverHost } from "./testing/fake-host.js";
import { createAgentDriverSdk } from "./sdk.js";
import { createAgentDriverRegistry } from "./registry.js";

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

  it("opens a sixth backend through only its public adapter registration", async () => {
    const capabilities = {
      modelSelection: "unsupported",
      providerConfiguration: false,
      reasoningEffort: false,
      fastMode: false,
      disallowedTools: false,
      commandOverride: false,
      resume: "none",
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
      execution: { kind: "per_turn_process", start: "deferred", afterTurn: "terminate" },
      probe: vi.fn(() => ({ status: "healthy" as const, version: "6.0.0" })),
      normalizeLine: () => [],
      currentSessionId: null,
      encodeMessage: () => null,
    };
    const registry = createAgentDriverRegistry<SixthSpecs>([{
      id: "sixth",
      capabilities,
      createAdapter: () => adapter,
    }]);
    const sdk = createAgentDriverSdk({ registry, host: createFakeAgentDriverHost() });

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
});
