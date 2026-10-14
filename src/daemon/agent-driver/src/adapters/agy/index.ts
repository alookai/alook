import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { AdapterEvent, AdapterLaunchContext, BackendAdapter, SpawnedProcessHandle } from "../../internal/adapter.js";
import { createProcessLane } from "../../controller/process-host.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { asRecord } from "../../internal/utils.js";
import { probeAgy, agySpawnSpec } from "./probe.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";

const STREAM_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];

function nativeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

export class AgyDriver implements BackendAdapter<"agy"> {
  readonly id = "agy";
  readonly instructionDelivery = { kind: "native" } as const;
  readonly execution = {
    lifetime: "session", transport: { kind: "stdio_stream", protocol: "agy.stream-json.v1" },
    wakeStart: "immediate", terminalOwnership: "vendor_message",
  } as const;
  private process?: SpawnedProcessHandle;
  private initialInput?: string;
  private sessionId: string | null = null;
  private requestedId?: string;
  private pending = false;
  private failed = false;
  private inputIndex?: number;
  private lastInputIndex = -1;
  private previousTurns?: number;
  private inputAt = "";
  private usageSource = "";
  private readonly usage = new SettledUsageProjector();
  private readonly tools = new Map<number, "active" | "done">();

  constructor(private readonly launchSpec?: ReturnType<typeof agySpawnSpec>) {}

  probe(command?: string) { return probeAgy(command); }

  async openLane(ctx: AdapterLaunchContext<"agy">, options?: { onRawStdoutLine?: (line: string) => void }) {
    const spec = agySpawnSpec(resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command);
    const probe = await probeAgy(spec.command);
    if (probe.status !== "healthy") throw new Error(probe.lastError);
    return createProcessLane(new AgyDriver(spec), ctx, options);
  }

  get currentSessionId() { return this.sessionId; }

  async spawn(ctx: AdapterLaunchContext<"agy">) {
    this.sessionId = null;
    this.failed = false;
    this.previousTurns = undefined;
    this.lastInputIndex = -1;
    const { spawnEnv } = await prepareCliTransport(ctx);
    const fields = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const saved = ctx.config.sessionId;
    this.requestedId = saved ? nativeId(saved) : undefined;
    if (saved && !this.requestedId) throw new Error("Invalid Antigravity CLI resume identity; reset explicitly");
    const args = [...STREAM_ARGS,
      ...(this.requestedId ? ["--conversation", this.requestedId] : []),
      ...(fields.model ? ["--model", fields.model] : []),
      ...(fields.reasoningEffort ? ["--effort", fields.reasoningEffort] : []),
    ];
    this.usageSource = `antigravity-cli:${createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}`;
    const spec = this.launchSpec ?? agySpawnSpec(fields.command);
    this.initialInput = this.encodeMessage([ctx.standingPrompt, ctx.prompt].filter(Boolean).join("\n\n")) ?? undefined;
    const process = spawnAgentProcess(spec.command, args, { cwd: ctx.workingDirectory, env: spawnEnv, shell: spec.shell });
    this.process = process;
    return { process };
  }

  encodeMessage(text: string, _sessionId?: string | null, options?: { mode?: "busy" | "idle" }): string | null {
    if (this.failed || options?.mode === "busy") return null;
    this.pending = true;
    this.inputIndex = undefined;
    this.usage.reset();
    this.tools.clear();
    return JSON.stringify({ event: "user", message: { content: text } });
  }

  normalizeLine(line: string): AdapterEvent[] {
    let event: Record<string, unknown> | null;
    try { event = asRecord(JSON.parse(line)); } catch { return this.fail("Antigravity CLI emitted invalid JSON"); }
    if (this.failed) return [];
    if (event?.event === "init") {
      const id = nativeId(event.conversation_id);
      if (!id || this.sessionId || (this.requestedId && id !== this.requestedId)) return this.fail("Antigravity CLI did not restore the requested conversation; reset explicitly");
      this.sessionId = id;
      const initial = this.initialInput;
      this.initialInput = undefined;
      try { if (initial) this.process?.stdin?.write(initial + "\n"); }
      catch { return this.fail("Antigravity CLI input is unavailable"); }
      return [{ kind: "session_init", sessionId: this.currentSessionId! }];
    }
    if (event?.event === "step_update") {
      const step = asRecord(event.step_update);
      if (!this.pending || !this.sessionId || step?.conversation_id !== this.sessionId) return [];
      const index = step.step_index;
      if (!Number.isSafeInteger(index) || (index as number) < 0) return this.fail("Antigravity CLI emitted an invalid step identity");
      if (step.step_type === "user_input" && step.state === "DONE" && this.inputIndex === undefined && (index as number) > this.lastInputIndex) {
        this.inputIndex = index as number;
        this.inputAt = new Date().toISOString();
        this.lastInputIndex = index as number;
        return [{ kind: "turn_owner", receipt: `agy:${this.sessionId}:${index}`, nativeTurnId: String(index) }];
      }
      if (this.inputIndex === undefined || (index as number) <= this.inputIndex) return [];
      const result: AdapterEvent[] = [];
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") result.push({ kind: "assistant_message_delta", text: step.text_delta });
      if (step.step_type === "tool") {
        const tool = asRecord(step.tool_info);
        const name = typeof step.tool_name === "string" ? step.tool_name : "tool";
        const callId = `${this.sessionId}:${index}`;
        if ((step.state === "ACTIVE" || step.state === "DONE") && !this.tools.has(index as number)) {
          this.tools.set(index as number, "active");
          result.push({ kind: "tool_call", callId, name, input: tool?.parameters });
        }
        if (step.state === "DONE" && this.tools.get(index as number) === "active") {
          this.tools.set(index as number, "done");
          result.push({ kind: "tool_output", callId, name });
        }
      }
      const usage = asRecord(step.usage);
      if (step.state === "DONE" && usage) {
        const projected = this.usage.project({ runtime: "antigravity-cli", backendSessionId: this.sessionId,
          providerRecordId: String(index), source: "antigravity.stream", input: usage.input_tokens,
          output: usage.output_tokens, cacheRead: usage.cache_read_tokens,
          inputIncludesCache: false, outputIncludesReasoning: true,
        });
        if (projected?.kind === "telemetry" && projected.name === "token_usage") result.push({ ...projected,
          identity: { source: `${this.usageSource}:${this.sessionId}`, index: index as number, occurredAt: this.inputAt },
        });
      }
      return result;
    }
    if (event?.event !== "result") return [];
    const result = asRecord(event.result);
    if (result?.status === "ERROR" && !this.sessionId) return this.fail(typeof result.error === "string" ? result.error : "Antigravity CLI initialization failed");
    if (!this.pending || result?.conversation_id !== this.sessionId) return [];
    const turns = result.num_turns;
    if (!Number.isSafeInteger(turns) || (turns as number) < 1) return this.fail("Antigravity CLI emitted an invalid turn counter");
    if (this.previousTurns !== undefined && (turns as number) <= this.previousTurns) return [];
    if (this.inputIndex === undefined || (this.previousTurns !== undefined && turns !== this.previousTurns + 1)) return this.fail("Antigravity CLI result has no matching current input");
    this.previousTurns = turns as number;
    this.pending = false;
    const events: AdapterEvent[] = [];
    const interrupted = result.status === "CANCELLED" || (result.status === "ERROR" && result.error === "interrupted");
    if (result.status === "SUCCESS") {
      if (typeof result.response !== "string") return this.fail("Antigravity CLI result is missing response text");
      events.push({ kind: "assistant_message_completed", text: result.response });
    } else if (!interrupted) events.push({ kind: "error", message: typeof result.error === "string" ? result.error : `Antigravity CLI status: ${String(result.status)}` });
    events.push({ kind: "turn_end", sessionId: this.currentSessionId!,
      ...(result.status !== "SUCCESS" ? { pendingContent: "discard" as const } : {}),
      ...(interrupted ? { outcome: "interrupted" as const } : {}),
    });
    return events;
  }

  private fail(message: string): AdapterEvent[] {
    this.failed = true;
    if (this.process?.pid) void killProcessTree(this.process.pid, { graceMs: 100 }).catch(() => {});
    return [{ kind: "error", message: /authentication (required|failed)/i.test(message)
      ? "Antigravity CLI authentication is unavailable. Run the configured Antigravity CLI in a terminal, complete sign-in, then retry."
      : message }];
  }

  async interrupt(): Promise<boolean> { return false; }
}
