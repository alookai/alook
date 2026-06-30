/**
 * Kimi SDK driver — canonical in-process Kimi runtime (frontend label "Kimi Code").
 *
 * Unlike the legacy `kimi` child-process driver, this runs the Kimi harness
 * in-process via @botiverse/kimi-code-sdk. There is no child process and no
 * stdin: `spawn` and `encodeStdinMessage` are unsupported. Instead the driver
 * builds a native `SdkRuntimeSession` whose `prompt`/`steer` call the SDK
 * session directly, and maps the SDK's event callback into `ParsedEvent`s.
 *
 * Steering is `direct` — the SDK accepts `session.steer(text)` any time.
 */
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { buildCliTransportSystemPrompt } from "./cliTransport.js";
import { SdkRuntimeSession, type SdkSessionHandle } from "../runtime/sdkRuntimeSession.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";

/** Map a Kimi SDK event to zero or more normalized events. */
export function mapKimiSdkEventToParsedEvents(event: any, sessionId: string): ParsedEvent[] {
  switch (event?.type) {
    case "thinking.delta":
      return [{ kind: "thinking", text: event.delta ?? "" }];
    case "assistant.delta":
      return [{ kind: "text", text: event.delta ?? "" }];
    case "tool.call.started":
      return [{ kind: "tool_call", name: event.name ?? "unknown_tool", input: event.args ?? {} }];
    case "tool.result":
      return [{ kind: "tool_output", name: "" }];
    case "compaction.started":
      return [{ kind: "compaction_started" }];
    case "compaction.completed":
      return [{ kind: "compaction_finished" }];
    case "error":
      return [{ kind: "error", message: event.message ?? "Kimi SDK error" }];
    case "turn.ended":
      return [{ kind: "turn_end", sessionId }];
    default:
      // Dropped: warning, turn.started, turn.step.*, tool.call.delta, tool.progress,
      // hook.result, agent.status.updated, session.meta.updated, goal.updated,
      // skill.activated, tool.list.updated, mcp.server.status, subagent.*,
      // compaction.blocked/cancelled, background.task.*, cron.fired.
      return [];
  }
}

export class KimiSdkDriver implements Driver {
  readonly id = "kimi-sdk";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "suggestion_only",
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  } as const;

  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;

  private sessionId: string | null = null;

  probe() {
    // The SDK is a bundled dependency; treat it as always available in-process.
    return { available: true };
  }

  spawn(): Promise<SpawnResult> {
    throw new Error("KimiSdkDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  /**
   * In-process session factory (analogue of spawn). Resolves the Kimi harness,
   * resumes or creates a session, wires events, and returns the wrapper.
   *
   * `harness`/`createKimiHarness` is injected so this file stays dependency-free
   * and unit-testable; the daemon supplies the real SDK.
   */
  async createSession(
    ctx: LaunchContext,
    deps: { createKimiHarness: (opts: any) => any; homeDir: string; daemonVersion: string },
  ): Promise<SdkRuntimeSession> {
    const harness = deps.createKimiHarness({
      homeDir: deps.homeDir,
      identity: {
        userAgentProduct: "kimi-code-cli",
        version: "0.14.3",
        userAgentSuffix: `agent-backend/${deps.daemonVersion}`,
      },
    });

    const model = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).model;
    const session = ctx.config.sessionId
      ? await harness.resumeSession({
          workDir: ctx.workingDirectory,
          id: ctx.config.sessionId,
          ...(model ? { model } : {}),
        })
      : await harness.createSession({ workDir: ctx.workingDirectory, ...(model ? { model } : {}) });

    this.sessionId = session.id ?? ctx.config.sessionId ?? "";
    session.setApprovalHandler(() => ({ decision: "approved", scope: "session" }));

    const handle: SdkSessionHandle = {
      prompt: (t: string) => session.prompt(t),
      steer: (t: string) => session.steer(t),
      abort: () => session.cancel(),
      dispose: () => session.close(),
      get isStreaming() {
        return session.isStreaming;
      },
    };
    const runtimeSession = new SdkRuntimeSession(handle, this.sessionId!);
    session.onEvent((event: any) =>
      runtimeSession.emitEvents(mapKimiSdkEventToParsedEvents(event, this.sessionId!)),
    );

    // Deliver the initial prompt.
    await session.prompt(ctx.prompt);
    return runtimeSession;
  }

  parseLine(): ParsedEvent[] {
    return []; // in-process: events come from the SDK callback, not stdout lines
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeStdinMessage(): string | null {
    return null; // no stdin; the daemon calls SdkRuntimeSession.send instead
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      postStartupNotes: [
        "**Kimi SDK runtime note:** The host keeps Kimi running as a persistent SDK session. While you are working, the host may send inbox-count notifications into the current turn; call `alook message check` at natural breakpoints.",
      ],
      includeStdinNotificationSection: true,
      messageNotificationStyle: "direct",
    });
  }
}
