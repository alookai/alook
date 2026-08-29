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

export class ClaudeEventNormalizer {
  private currentSession: string | null = null;
  private readonly usageProjector = new SettledUsageProjector();

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
    const u = event?.usage;
    if (!u) return null;
    const backendSessionId = event.session_id ?? this.currentSession;
    if (typeof backendSessionId !== "string" || !backendSessionId) return null;
    const providerRecordId = rootRequestId
      ?? (typeof event.request_id === "string" ? event.request_id : "invocation-result");
    return this.usageProjector.project({
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
  }
}
