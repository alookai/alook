/**
 * Kimi driver — persistent child-process CLI over JSON-RPC, DIRECT steering.
 *
 * `kimi --wire --yolo --agent-file <file> --session <id>` runs a long-lived
 * process speaking JSON-RPC 2.0 over stdio (the "wire" protocol). On spawn we
 * send `initialize` then a `prompt`; thereafter idle messages are `prompt` and
 * busy messages are `steer`.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { Driver, EncodeOpts, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { resolveCommandOnPath, probeCliRuntime } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";

function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

export class KimiDriver implements Driver {
  readonly id = "kimi";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;

  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;

  private sessionId = "";
  private sentInit = false;
  private promptRequestId = randomUUID();

  probe() {
    return probeCliRuntime("kimi");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || randomUUID();
    const isResume = Boolean(ctx.config.sessionId);
    const { stateDir, spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });

    // The standing prompt is delivered to Kimi via an agent file.
    const agentFilePath = `${stateDir}/kimi-agent.md`;
    const fs = await import("fs");
    fs.writeFileSync(agentFilePath, ctx.standingPrompt, { mode: 0o600 });

    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const args = ["--wire", "--yolo", "--agent-file", agentFilePath, "--session", this.sessionId];
    if (f.model) args.push("--model", f.model);

    const command = resolveCommandOnPath("kimi") ?? "kimi";
    const proc = spawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });

    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "initialize",
        params: {
          protocol_version: "1.3",
          client: { name: "agent-backend", version: "1.0.0" },
          capabilities: { supports_question: false, supports_plan_mode: false },
        },
      }) + "\n",
    );
    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.promptRequestId,
        method: "prompt",
        params: {
          user_input: isResume
            ? ctx.prompt
            : "Your system prompt contains your standing instructions. Follow it now and begin listening for messages.",
        },
      }) + "\n",
    );

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const out: ParsedEvent[] = [];
    if (!this.sentInit) {
      this.sentInit = true;
      out.push({ kind: "session_init", sessionId: this.sessionId });
    }

    if (msg?.error) {
      out.push({ kind: "error", message: msg.error?.message ?? "Unknown Kimi error" });
      out.push({ kind: "turn_end", sessionId: this.sessionId });
      return out;
    }
    if (msg?.method !== "event") return out;

    const payload = msg.params ?? {};
    switch (payload.event) {
      case "StepBegin":
        out.push({ kind: "thinking", text: "" });
        break;
      case "CompactionBegin":
        out.push({ kind: "compaction_started" });
        break;
      case "CompactionEnd":
        out.push({ kind: "compaction_finished" });
        break;
      case "ContentPart":
        if (payload.type === "think") out.push({ kind: "thinking", text: payload.think ?? "" });
        else if (payload.type === "text") out.push({ kind: "text", text: payload.text ?? "" });
        break;
      case "ToolCall":
        out.push({
          kind: "tool_call",
          name: payload.function?.name ?? "unknown_tool",
          input: parseToolArguments(payload.function?.arguments),
        });
        break;
      case "TurnEnd":
        out.push({ kind: "turn_end", sessionId: this.sessionId });
        break;
      case "StepInterrupted":
        out.push({ kind: "error", message: "Turn interrupted" });
        out.push({ kind: "turn_end", sessionId: this.sessionId });
        break;
    }
    return out;
  }

  get currentSessionId(): string | null {
    return this.sessionId || null;
  }

  /** idle → `prompt`; busy → `steer`. */
  encodeStdinMessage(text: string, _sessionId: string | null, opts?: EncodeOpts): string | null {
    const method = opts?.mode === "idle" ? "prompt" : "steer";
    return JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { user_input: text } });
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      postStartupNotes: [],
      includeStdinNotificationSection: true,
      messageNotificationStyle: "direct",
    });
  }
}
