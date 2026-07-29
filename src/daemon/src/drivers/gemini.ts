/**
 * Gemini driver — per-turn, stream-json, no steering.
 *
 * Gemini CLI is launched once per wake with `--output-format stream-json
 * --yolo -p ""`; the prompt is written to stdin and stdin is then closed. The
 * process produces a stream-json transcript and exits — that exit IS the turn
 * boundary. No mid-session input is possible (`encodeStdinMessage` → null), so
 * new messages mean a brand-new process and the agent polls the inbox.
 */
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";
import { tryParseJsonLine, writeToStdinAndDetach } from "./utils.js";

export function buildGeminiArgs(config: LaunchConfig): string[] {
  const f = resolveLaunchFieldsOrDefault(config.runtimeConfig);
  return [
    "--output-format",
    "stream-json",
    "--yolo",
    "-p",
    "",
    ...(f.model ? ["--model", f.model] : []),
    ...(config.sessionId ? ["--resume", config.sessionId] : []),
  ];
}

export class GeminiDriver implements Driver {
  readonly id = "gemini";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) =>
      modelId ? { args: ["--model", modelId] } : { args: [] },
  } as const;


  readonly capabilities = {
    reasoningEffort: false,
    fastMode: false,
    disallowedTools: false,
    command: true,
    sessionResumeMode: "by-id",
  } as const;

  private sessionId: string | null = null;

  probe() {
    return probeCliRuntime("gemini");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;
    const { spawnEnv } = await prepareCliTransport(ctx);
    // Gemini refuses to run in a workspace it doesn't "trust" — an interactive
    // gate that has no meaning for a headless spawn. Force-trust the workdir
    // unconditionally; the sandboxing that gate is intended to provide is
    // already covered by the credential proxy + capability scope.
    spawnEnv.GEMINI_CLI_TRUST_WORKSPACE ??= "true";
    if (process.platform === "win32") spawnEnv.GEMINI_PTY_INFO ??= "child_process";

    // Cross-platform spawn: on Windows the gemini entry is often a `.cmd` shim.
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("gemini", buildGeminiArgs(ctx.config), override);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    // Prompt in, then close stdin — one-shot.
    writeToStdinAndDetach(proc, ctx.prompt);
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    const event = tryParseJsonLine(line) as any;
    if (!event) return [];
    switch (event?.type) {
      case "init":
        this.sessionId = event.session_id ?? this.sessionId;
        return this.sessionId ? [{ kind: "session_init", sessionId: this.sessionId }] : [];
      case "message":
        if (event.role === "assistant" && event.content) return [{ kind: "text", text: event.content }];
        return [];
      case "tool_use":
        return [{ kind: "tool_call", name: event.tool_name ?? "unknown_tool", input: event.parameters }];
      case "error":
        return [{ kind: "error", message: event.message ?? "Gemini error" }];
      case "result":
        return event.status && event.status !== "success"
          ? [{ kind: "error", message: String(event.status) }, { kind: "turn_end", sessionId: this.sessionId ?? undefined }]
          : [{ kind: "turn_end", sessionId: this.sessionId ?? undefined }];
      default:
        return [];
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeStdinMessage(): string | null {
    return null; // per-turn: no mid-session input
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config);
  }
}
