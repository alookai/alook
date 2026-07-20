/**
 * Copilot driver — per-turn, JSON output, no steering.
 *
 * `copilot --output-format json --allow-all-tools --allow-all-paths -p <prompt>`
 * is launched per wake; the prompt is passed as the `-p` argument (nothing is
 * written to stdin). Emits a JSON event stream and exits.
 */
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";

export class CopilotDriver implements Driver {
  readonly id = "copilot";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;

  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;

  probe() {
    // Detection is `copilot --version` via the shared probe. On a machine where
    // the real Copilot CLI isn't installed, the `copilot` that resolves on PATH
    // is often the VS Code extension shim (e.g.
    // `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot`),
    // which exits 0 and prints `Install GitHub Copilot CLI? ['y/N']` instead of
    // a version. `probeCommandVersion`'s version-shape validation rejects that
    // output, so this reports `unhealthy` (not-installed) rather than surfacing
    // the prompt text as a bogus version. Verified on macOS.
    return probeCliRuntime("copilot");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const args = ["--output-format", "json", "--allow-all-tools", "--allow-all-paths", "-p", ctx.prompt];
    if (f.model) args.push("--model", f.model);
    if (f.reasoningEffort) args.push("--effort", f.reasoningEffort);
    if (ctx.config.sessionId) args.push(`--resume=${ctx.config.sessionId}`);

    // Cross-platform spawn: on Windows the copilot entry is often a `.cmd`
    // shim, which `child_process.spawn` can't exec without a shell.
    const spec = resolveSpawnSpec("copilot", args);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    switch (event?.type) {
      case "assistant.turn_start":
        if (event.sessionId) this.sessionId = event.sessionId;
        return this.sessionId ? [{ kind: "session_init", sessionId: this.sessionId }] : [];
      case "assistant.reasoning":
        return [{ kind: "thinking", text: event.content ?? "" }];
      case "assistant.message_delta":
        return [{ kind: "text", text: event.deltaContent ?? "" }];
      case "assistant.message": {
        const reqs = event.message?.toolRequests ?? [];
        return reqs.map((req: any) => ({
          kind: "tool_call" as const,
          name: req.name ?? req.toolName ?? "unknown_tool",
          input: req.arguments ?? req.parameters ?? req.input ?? {},
        }));
      }
      case "assistant.turn_end":
        return [{ kind: "turn_end", sessionId: this.sessionId ?? undefined }];
      case "result":
        if (event.sessionId) this.sessionId = event.sessionId;
        return event.exitCode && event.exitCode !== 0
          ? [{ kind: "error", message: `Copilot exited with code ${event.exitCode}` }, { kind: "turn_end" }]
          : [{ kind: "turn_end", sessionId: this.sessionId ?? undefined }];
      default:
        return [];
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, { lifecycleKind: this.lifecycle.kind });
  }
}
