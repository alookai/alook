/**
 * ClaudeEventNormalizer — turns Claude Code's stream-json output into the
 * uniform `ParsedEvent` vocabulary.
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
import type { ParsedEvent } from "../types.js";

const API_ERROR_RE = /API Error:.*(?:Connection error|\b[45]\d{2}\b)/i;

export class ClaudeEventNormalizer {
  private currentSession: string | null = null;

  get currentSessionId(): string | null {
    return this.currentSession;
  }

  normalizeLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (event?.session_id) this.currentSession = event.session_id;

    const out: ParsedEvent[] = [];
    switch (event?.type) {
      case "system":
        this.handleSystem(event, out);
        break;
      case "assistant":
        this.handleAssistant(event, out);
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

  private handleSystem(event: any, out: ParsedEvent[]): void {
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

  private handleAssistant(event: any, out: ParsedEvent[]): void {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "thinking") {
        out.push({ kind: "thinking", text: block.thinking ?? "" });
      } else if (block?.type === "text") {
        const text: string = block.text ?? "";
        if (API_ERROR_RE.test(text)) out.push({ kind: "error", message: text });
        else out.push({ kind: "text", text });
      } else if (block?.type === "tool_use") {
        out.push({ kind: "tool_call", name: block.name ?? "unknown_tool", input: block.input });
      }
    }
  }

  private handleUser(event: any, out: ParsedEvent[]): void {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_result") out.push({ kind: "tool_output", name: "" });
    }
  }

  private handleResult(event: any, out: ParsedEvent[]): void {
    const usage = this.buildUsageTelemetry(event);
    if (usage) out.push(usage);
    if (event.is_error || event.subtype === "error_during_execution") {
      out.push({ kind: "error", message: String(event.result ?? "Claude runtime error") });
    }
    out.push({ kind: "turn_end", sessionId: event.session_id ?? this.currentSession ?? undefined });
  }

  private buildUsageTelemetry(event: any): ParsedEvent | null {
    const u = event?.usage;
    if (!u && event?.total_cost_usd == null) return null;
    return {
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      attrs: {
        inputTokens: u?.input_tokens,
        outputTokens: u?.output_tokens,
        cachedInputTokens: u?.cache_read_input_tokens,
        cacheCreationInputTokens: u?.cache_creation_input_tokens,
        totalCostUsd: event?.total_cost_usd,
        durationMs: event?.duration_ms,
        durationApiMs: event?.duration_api_ms,
        numTurns: event?.num_turns,
        resultSubtype: event?.subtype,
        resultIsError: event?.is_error,
        serviceTier: u?.service_tier,
      },
    };
  }
}
