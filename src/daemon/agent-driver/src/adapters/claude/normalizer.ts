/**
 * ClaudeEventNormalizer — turns Claude Code's stream-json output into the
 * uniform `AdapterEvent` vocabulary.
 *
 * Claude emits one JSON object per line. The shapes we care about:
 *   - `{type:"system", subtype:"init", session_id}`            → session_init
 *   - `{type:"system", subtype:"status", status:"compacting"}` → compaction_started
 *   - `{type:"system", subtype:"compact_boundary"}`            → compaction_finished
 *   - `{type:"system", subtype:"status"|"stream_event"}`       → internal_progress
 *   - `{type:"assistant", message:{content:[…]}}`              → thinking / text / tool_call
 *   - `{type:"user", message:{content:[tool_result]}}`         → tool_output
 *   - `{type:"result", …}`                                     → telemetry + turn_end / error
 *
 * The `session_id` on any line keeps `currentSessionId` fresh for resume.
 */
import type { AdapterEvent } from "../../internal/adapter.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { tryParseJsonLine } from "../../internal/utils.js";
import type { ClaudeTurnProtocol } from "./turnProtocol.js";

const API_ERROR_RE = /API Error:.*(?:Connection error|\b[45]\d{2}\b)/i;
const CLAUDE_USAGE_COMPONENTS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

interface ClaudeModelUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

interface ClaudeModelUsageProjection {
  highWater: Map<string, ClaudeModelUsageSnapshot>;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeAdd(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function equalCost(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-9);
}

export class ClaudeEventNormalizer {
  private currentSession: string | null = null;
  private readonly usageProjector = new SettledUsageProjector();
  private claudeUsageSession: string | null = null;
  private claudeModelUsageHighWater = new Map<string, ClaudeModelUsageSnapshot>();
  private claudeUsageMode: "unknown" | "legacy" | "model_usage" | "invalid" = "unknown";

  constructor(private readonly turnProtocol?: ClaudeTurnProtocol) {}

  beginTurn(): void {
    this.usageProjector.reset();
  }

  get currentSessionId(): string | null {
    return this.currentSession;
  }

  normalizeLine(line: string): AdapterEvent[] {
    const event = tryParseJsonLine(line) as any;
    if (!event) return [];
    if (event?.session_id) this.currentSession = event.session_id;

    const out: AdapterEvent[] = [];
    switch (event?.type) {
      case "system":
        if (event.subtype === "init" || this.acceptsTurnWork()) this.handleSystem(event, out);
        break;
      case "assistant":
        if (this.acceptsTurnWork()) this.handleAssistant(event, out);
        break;
      case "user":
        this.handleUser(event, out);
        break;
      case "result":
        this.handleResult(event, out);
        break;
    }
    return out;
  }

  private handleSystem(event: any, out: AdapterEvent[]): void {
    if (event.subtype === "init") {
      out.push({ kind: "session_init", sessionId: event.session_id ?? this.currentSession ?? "" });
      return;
    }
    if (event.subtype === "status" && event.status === "compacting") {
      out.push({ kind: "compaction_started" });
      return;
    }
    if (event.subtype === "compact_boundary") {
      out.push({ kind: "compaction_finished" });
      return;
    }
    if (event.subtype === "status" || event.subtype === "stream_event") {
      out.push({
        kind: "internal_progress",
        source: "claude_system",
        itemType: event.subtype,
        payloadBytes: JSON.stringify(event).length,
      });
    }
  }

  private handleAssistant(event: any, out: AdapterEvent[]): void {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    const completedText: string[] = [];
    for (const block of content) {
      if (block?.type === "thinking") {
        out.push({ kind: "assistant_reasoning_completed", text: block.thinking ?? "" });
      } else if (block?.type === "text") {
        const text: string = block.text ?? "";
        if (API_ERROR_RE.test(text)) out.push({ kind: "error", message: text });
        else completedText.push(text);
      } else if (block?.type === "tool_use") {
        out.push({ kind: "tool_call", name: block.name ?? "unknown_tool", input: block.input });
      }
    }
    if (completedText.length > 0) {
      out.push({ kind: "assistant_message_completed", text: completedText.join("") });
    }
  }

  private handleUser(event: any, out: AdapterEvent[]): void {
    if (event.isReplay === true && typeof event.uuid === "string") {
      this.turnProtocol?.acknowledge(event.uuid);
    }
    if (!this.acceptsTurnWork()) return;
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_result") out.push({ kind: "tool_output", name: "" });
    }
  }

  private handleResult(event: any, out: AdapterEvent[]): void {
    const rawOwner = typeof event.user_message_uuid === "string" && event.user_message_uuid.length > 0
      ? event.user_message_uuid
      : null;
    const turnOwner = rawOwner
      ? this.turnProtocol?.claimResult(rawOwner) ?? (this.turnProtocol ? null : `claude:${rawOwner}`)
      : null;
    if (this.turnProtocol && !turnOwner) return;
    const usage = this.buildUsageTelemetry(event, rawOwner);
    if (usage) out.push(usage);
    if (event.is_error || event.subtype === "error_during_execution") {
      out.push({ kind: "error", message: String(event.result ?? "Claude runtime error") });
    }
    out.push({
      kind: "turn_end",
      sessionId: event.session_id ?? this.currentSession ?? undefined,
      ...(turnOwner ? { turnOwner } : {}),
    });
  }

  private acceptsTurnWork(): boolean {
    return this.turnProtocol?.acceptsTurnWork() ?? true;
  }

  private buildUsageTelemetry(event: any, rootRequestId: string | null): AdapterEvent | null {
    const backendSessionId = event.session_id ?? this.currentSession;
    if (typeof backendSessionId !== "string" || !backendSessionId) return null;
    const providerRecordId = rootRequestId
      ?? (typeof event.request_id === "string" ? event.request_id : "invocation-result");
    const cumulative = this.prepareClaudeModelUsage(event, backendSessionId);
    if (cumulative === null) return null;
    if (cumulative) {
      const hasDelta = cumulative.input > 0
        || cumulative.output > 0
        || cumulative.cacheRead > 0
        || cumulative.cacheWrite > 0;
      if (!hasDelta) {
        this.commitClaudeModelUsage(backendSessionId, cumulative);
        return null;
      }
      const projected = this.usageProjector.project({
        runtime: "claude",
        backendSessionId,
        providerRecordId,
        source: "claude_result_model_usage",
        input: cumulative.input,
        output: cumulative.output,
        cacheRead: cumulative.cacheRead,
        cacheWrite: cumulative.cacheWrite,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
      });
      if (projected) this.commitClaudeModelUsage(backendSessionId, cumulative);
      return projected;
    }

    const u = event?.usage;
    if (!u) return null;
    const projected = this.usageProjector.project({
      runtime: "claude",
      backendSessionId,
      providerRecordId,
      source: "claude_result_usage",
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
    });
    if (projected) this.claudeUsageMode = "legacy";
    return projected;
  }

  /**
   * Claude Code reports `result.modelUsage` as a cumulative snapshot for the
   * lifetime of one physical stream-json process. Keep that high-water mark
   * across logical turns and project only the component-wise delta.
   *
   * `undefined` means this runtime has not exposed modelUsage, so the legacy
   * per-result `usage` fallback is still safe. `null` skips the snapshot
   * without committing it. Malformed/regressed snapshots may recover on a
   * later complete high-water; session or usage-mode switches lock the
   * normalizer closed because their accounting identities cannot be joined.
   */
  private prepareClaudeModelUsage(
    event: any,
    backendSessionId: string,
  ): ClaudeModelUsageProjection | null | undefined {
    if (this.claudeUsageMode === "invalid") return null;
    if (!Object.hasOwn(event ?? {}, "modelUsage")) {
      if (this.claudeUsageMode !== "model_usage") return undefined;
      return event?.usage ? this.lockClaudeUsageMode() : null;
    }
    if (this.claudeUsageMode === "legacy") return this.lockClaudeUsageMode();
    if (this.claudeUsageMode === "unknown") this.claudeUsageMode = "model_usage";
    this.claudeUsageSession ??= backendSessionId;
    if (this.claudeUsageSession !== null && this.claudeUsageSession !== backendSessionId) {
      return this.lockClaudeUsageMode();
    }
    if (!event.modelUsage || typeof event.modelUsage !== "object" || Array.isArray(event.modelUsage)) {
      return null;
    }
    const entries = Object.entries(event.modelUsage);
    if (entries.length === 0) return null;

    const highWater = new Map<string, ClaudeModelUsageSnapshot>();
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let snapshotCost = 0;
    for (const [model, rawValue] of entries) {
      if (!model.trim() || !rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
        return null;
      }
      const raw = rawValue as Record<string, unknown>;
      const current = {
        inputTokens: safeCount(raw.inputTokens),
        outputTokens: safeCount(raw.outputTokens),
        cacheReadInputTokens: safeCount(raw.cacheReadInputTokens),
        cacheCreationInputTokens: safeCount(raw.cacheCreationInputTokens),
        costUSD: safeMoney(raw.costUSD),
      };
      if (Object.values(current).some((value) => value === null)) {
        return null;
      }
      const snapshot = current as ClaudeModelUsageSnapshot;
      const prior = this.claudeModelUsageHighWater.get(model) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      };
      for (const component of CLAUDE_USAGE_COMPONENTS) {
        if (snapshot[component] < prior[component]) return null;
      }
      if (snapshot.costUSD < prior.costUSD) return null;

      const nextInput = safeAdd(input, snapshot.inputTokens - prior.inputTokens);
      const nextOutput = safeAdd(output, snapshot.outputTokens - prior.outputTokens);
      const nextCacheRead = safeAdd(cacheRead, snapshot.cacheReadInputTokens - prior.cacheReadInputTokens);
      const nextCacheWrite = safeAdd(cacheWrite, snapshot.cacheCreationInputTokens - prior.cacheCreationInputTokens);
      if (nextInput === null || nextOutput === null || nextCacheRead === null || nextCacheWrite === null) {
        return null;
      }
      input = nextInput;
      output = nextOutput;
      cacheRead = nextCacheRead;
      cacheWrite = nextCacheWrite;
      snapshotCost += snapshot.costUSD;
      if (!Number.isFinite(snapshotCost)) return null;
      highWater.set(model, snapshot);
    }
    for (const model of this.claudeModelUsageHighWater.keys()) {
      if (!highWater.has(model)) return null;
    }
    if (Object.hasOwn(event, "total_cost_usd")) {
      const totalCost = safeMoney(event.total_cost_usd);
      if (totalCost === null || !equalCost(snapshotCost, totalCost)) return null;
    }
    return { highWater, input, output, cacheRead, cacheWrite };
  }

  private commitClaudeModelUsage(
    backendSessionId: string,
    projection: ClaudeModelUsageProjection,
  ): void {
    this.claudeUsageSession ??= backendSessionId;
    this.claudeModelUsageHighWater = projection.highWater;
    this.claudeUsageMode = "model_usage";
  }

  private lockClaudeUsageMode(): null {
    this.claudeUsageMode = "invalid";
    return null;
  }
}
