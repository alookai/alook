/**
 * Pi driver — in-process, multi-provider SDK runtime (@earendil-works/pi-coding-agent).
 *
 * Like kimi-sdk, Pi runs in-process (no child process, no stdin). It is
 * multi-provider: model ids look like `provider/id` and resolve through an
 * auth/settings registry (Google / OpenAI / OpenRouter). Sessions persist as
 * JSONL; a custom bash tool is injected so shell calls inherit the CLI-transport
 * env. Steering is `direct` (guarded by `session.isStreaming`).
 */
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types";
import { buildCliTransportSystemPrompt } from "./cliTransport";
import { SdkRuntimeSession, type SdkSessionHandle } from "../runtime/sdkRuntimeSession";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig";

/** Map a Pi SDK event to zero or more normalized events. */
export function mapPiSdkEventToParsedEvents(event: any, sessionId: string, state: { sawTextDelta: boolean }): ParsedEvent[] {
  if (event?.type === "message_update") {
    const d = event.delta ?? {};
    switch (d.type) {
      case "thinking_delta":
        return [{ kind: "thinking", text: d.delta ?? "" }];
      case "text_delta":
        state.sawTextDelta = true;
        return [{ kind: "text", text: d.delta ?? "" }];
      case "text_end":
        return state.sawTextDelta ? [] : [{ kind: "text", text: d.content ?? "" }];
      case "error":
        return [{ kind: "error", message: d.message ?? "Pi error" }];
      default:
        return [];
    }
  }
  switch (event?.type) {
    case "tool_execution_start":
      return [{ kind: "tool_call", name: event.toolName ?? "unknown_tool", input: event.args ?? {} }];
    case "tool_execution_end":
      return [{ kind: "tool_output", name: event.toolName ?? "unknown_tool" }];
    case "compaction_start":
      return [{ kind: "compaction_started" }];
    case "compaction_end":
      return [{ kind: "compaction_finished" }];
    case "agent_end":
      return [{ kind: "turn_end", sessionId }];
    default:
      // Dropped: agent_start, turn_start, turn_end, message_end,
      // tool_execution_update, queue_update, session_info_changed,
      // thinking_level_changed, auto_retry_start, auto_retry_end, …
      return [];
  }
}

export class PiDriver implements Driver {
  readonly id = "pi";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  } as const;

  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;

  private sessionId: string | null = null;

  probe() {
    return { available: true }; // bundled SDK
  }

  spawn(): Promise<SpawnResult> {
    throw new Error("PiDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  /**
   * In-process session factory. `deps` carries the Pi SDK constructors so this
   * file is dependency-free; the daemon injects the real implementations.
   */
  async createSession(
    ctx: LaunchContext,
    deps: {
      buildSpawnEnv: () => Promise<NodeJS.ProcessEnv>;
      createAgentSession: (opts: any) => Promise<{ session: any; sessionId: string }>;
    },
  ): Promise<SdkRuntimeSession> {
    const spawnEnv = await deps.buildSpawnEnv();
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const { session, sessionId } = await deps.createAgentSession({
      cwd: ctx.workingDirectory,
      sessionId: ctx.config.sessionId,
      standingPrompt: ctx.standingPrompt,
      model: f.model,
      thinkingLevel: f.reasoningEffort,
      spawnEnv, // injected into the custom bash tool
    });
    this.sessionId = sessionId;

    const state = { sawTextDelta: false };
    const handle: SdkSessionHandle = {
      prompt: (t: string) => session.prompt(t),
      steer: (t: string) => session.steer(t),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      get isStreaming() {
        return session.isStreaming;
      },
    };
    const runtimeSession = new SdkRuntimeSession(handle, this.sessionId!);
    session.subscribe((event: any) =>
      runtimeSession.emitEvents(mapPiSdkEventToParsedEvents(event, this.sessionId!, state)),
    );

    await session.prompt(ctx.prompt);
    return runtimeSession;
  }

  parseLine(): ParsedEvent[] {
    return [];
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      postStartupNotes: [
        "**Pi runtime note:** The host keeps Pi running as a persistent SDK session. While you are working, the host may send inbox-count notifications into the current turn; call `alook message check` at natural breakpoints.",
      ],
      includeStdinNotificationSection: true,
      messageNotificationStyle: "direct",
    });
  }
}
