import { readPiSdkVersion } from "./paths.js";

import type {
  BackendAdapter, AdapterLaunchContext, AdapterEvent, VendorSessionHandle,
} from "../../internal/adapter.js";
import { SdkLane } from "../../controller/sdk-host.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { parsePiModelCatalog } from "../../internal/modelCatalog.js";
import {
  createPiSessionDependencies,
  loadPiSdkModule,
  type PiSdkLoader,
  type PiSessionDependencies,
} from "./sessionDeps.js";
import { discoverPiRecentContext } from "./recent-context.js";

const PI_MODEL_PROBE_TIMEOUT_MS = 5_000;

interface PiSdkAgentSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
}

/** Vendor notifications that intentionally carry no public semantic event. */
export const PI_IGNORED_EVENT_TYPES = [
  "agent_start",
  "turn_start",
  "tool_execution_update",
  "queue_update",
  "session_info_changed",
  "thinking_level_changed",
  "agent_end",
] as const;

interface PiEventState {
  sawTextDelta: boolean;
  usageProjector?: SettledUsageProjector;
  pendingUsageRecordIds?: Set<string>;
  usageRecordSequence?: number;
}

function piUsageState(state: PiEventState) {
  state.usageProjector ??= new SettledUsageProjector();
  state.pendingUsageRecordIds ??= new Set<string>();
  return { projector: state.usageProjector, pending: state.pendingUsageRecordIds };
}

export function mapPiSdkEvent(event: any, sessionId: string, state: PiEventState): AdapterEvent[] {
  if (event?.type === "message_update") {
    const d = event.assistantMessageEvent ?? {};
    switch (d.type) {
      case "thinking_delta":
        return [{ kind: "assistant_reasoning_delta", text: d.delta ?? "" }];
      case "text_delta":
        state.sawTextDelta = true;
        return [{ kind: "assistant_message_delta", text: d.delta ?? "" }];
      case "text_end": {
        state.sawTextDelta = false;
        return [{ kind: "assistant_message_completed", text: d.content ?? "" }];
      }
      case "error":
        return [{
          kind: "error",
          code: "pi.message_error",
          message: d.error?.errorMessage ?? "Pi error",
        }];
      default:
        return [];
    }
  }
  switch (event?.type) {
    case "message_end": {
      const message = event.message;
      if (message?.role !== "assistant" || !message.usage) return [];
      state.usageRecordSequence = (state.usageRecordSequence ?? 0) + 1;
      const providerRecordId = typeof message.responseId === "string" && message.responseId
        ? message.responseId
        : `live:${message.timestamp ?? "unknown"}:${state.usageRecordSequence}`;
      const { projector, pending } = piUsageState(state);
      const identity = { runtime: "pi", backendSessionId: sessionId, providerRecordId } as const;
      const usage = projector.project({
        ...identity,
        source: "pi_message_end",
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
      });
      pending.add(providerRecordId);
      return usage ? [usage] : [];
    }
    case "turn_end": {
      const { projector, pending } = piUsageState(state);
      for (const providerRecordId of pending) {
        projector.release({ runtime: "pi", backendSessionId: sessionId, providerRecordId });
      }
      pending.clear();
      return [];
    }
    case "auto_retry_start":
      return [{ kind: "runtime_recovery", stage: "retrying", source: "pi_auto_retry" }];
    case "auto_retry_end":
      return [{ kind: "runtime_recovery", stage: "recovered", source: "pi_auto_retry" }];
    case "tool_execution_start":
      return [{ kind: "tool_call", callId: event.toolCallId, name: event.toolName ?? "unknown_tool", input: event.args ?? {} }];
    case "tool_execution_end":
      return [{ kind: "tool_output", callId: event.toolCallId, name: event.toolName ?? "unknown_tool", outcome: event.isError === true ? "failed" : event.isError === false ? "success" : "unknown", output: event.result }];
    case "compaction_start":
      return [{ kind: "compaction_started" }];
    case "compaction_end":
      return [{ kind: "compaction_finished" }];
    default:

      return [];
  }
}

export class PiDriver implements BackendAdapter {
  readonly id = "pi";
  readonly modelCatalogOrigin = "native_report" as const;
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "in_process_sdk", protocol: "pi_sdk" },
    wakeStart: "immediate",
    terminalOwnership: "prompt_invocation",
  } as const;

  private sessionId: string | null = null;
  private terminalSequence = 0;

  discoverRecentContext(request: Parameters<typeof discoverPiRecentContext>[0]) {
    return discoverPiRecentContext(request);
  }

  constructor(
    private readonly dependenciesFor: (ctx: AdapterLaunchContext) => PiSessionDependencies = createPiSessionDependencies,
    private readonly loadSdk: PiSdkLoader = loadPiSdkModule,
    private readonly readVersion: () => string | undefined = readPiSdkVersion,
  ) {}

  async probe(_command?: string, includeModels = true) {
    const version = this.readVersion();
    if (!version) {
      // The Pi SDK is a native runtime — no CLI to spawn. If the npm module
      // isn't require-able, treat the runtime as unhealthy so /community
      // reflects reality and the bot picker filters it out.
      return { status: "unhealthy" as const, lastError: "sdk_not_installed" };
    }
    if (!includeModels) return { status: "healthy" as const, version };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reasoning = await Promise.race([
        this.loadSdk().then(async (sdk) => {
          const modelRuntime = sdk.ModelRegistry && sdk.AuthStorage
            ? sdk.ModelRegistry.create(sdk.AuthStorage.create())
            : await sdk.ModelRuntime.create();
          return parsePiModelCatalog(await modelRuntime.getAvailable());
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), PI_MODEL_PROBE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      return { status: "healthy" as const, version, reasoning };
    } catch {
      return { status: "healthy" as const, version, reasoning: undefined };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // EventEmitter does not buffer: the controller must attach listeners before the first prompt.
  async openLane(ctx: AdapterLaunchContext): Promise<SdkLane> {
    const deps = this.dependenciesFor(ctx);
    const spawnEnv = await deps.buildSpawnEnv();
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const { session, sessionId } = (await deps.createAgentSession({
      cwd: ctx.workingDirectory,
      sessionId: ctx.config.sessionId,
      model: f.model,
      thinkingLevel: f.reasoningEffort,
      spawnEnv,
    })) as { session: PiSdkAgentSession; sessionId: string };
    this.sessionId = sessionId;

    const state = { sawTextDelta: false };
    const handle: VendorSessionHandle = {
      // A root turn is owned by this exact prompt promise. Never downgrade it
      // to followUp/steer, whose completion belongs to a different invocation.
      // SdkLane waits for idle and turns a persistent-busy race into a
      // controlled failed terminal instead of guessing terminal ownership.
      prompt: (t: string) => session.prompt(t),
      steer: (t: string) => session.steer(t),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      get isStreaming() {
        return session.isStreaming;
      },
    };
    const runtimeSession = new SdkLane(handle, this.sessionId!, { terminalOnPromptSettled: true, acquisition: { status: ctx.config.sessionId ? "resumed" : "created", evidence: "native_api" } });
    session.subscribe((event: unknown) => {
      runtimeSession.emitEvents(mapPiSdkEvent(event, this.sessionId!, state));
    });

    return runtimeSession;
  }

  normalizeLine(): AdapterEvent[] {
    return [];
  }

  beginTurn(): string {
    return `pi:${++this.terminalSequence}`;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeMessage(): string | null {
    return null;
  }

}
