/**
 * CodexEventNormalizer — maps Codex's JSON-RPC 2.0 app-server protocol into
 * `ParsedEvent`s.
 *
 * Codex speaks JSON-RPC over stdio (`app-server --listen stdio://`). After an
 * `initialize` handshake the daemon starts/resumes a thread; the thread then
 * streams `item/*` and `turn/*` notifications. Session id = the thread id from
 * the `thread/started` (or thread/resume) result.
 *
 * It also folds in two telemetry streams via the sidecar mapper:
 *   - `thread/tokenUsage/updated`     → cumulative-session token telemetry
 *   - `account/rateLimits/updated`    → rate-limit telemetry
 */
import type { ParsedEvent } from "../types.js";
import { mapCodexTelemetry } from "./codexTelemetrySidecar.js";
import { RuntimeTurnState } from "../runtime/turnState.js";

export class CodexEventNormalizer {
  private threadId: string | null = null;
  /** Tracks turn/tool boundaries so the driver can answer `canSteerBusy`. */
  readonly turnState = new RuntimeTurnState();

  get currentSessionId(): string | null {
    return this.threadId;
  }

  /** Safe to inject a busy (steering) message right now? */
  get canSteerBusy(): boolean {
    return this.turnState.canSteerBusy;
  }

  adoptThreadId(threadId: string | null): void {
    this.threadId = threadId;
  }

  normalizeLine(line: string): ParsedEvent[] {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }

    // JSON-RPC error response.
    if (msg?.error && msg.id !== undefined) {
      return [{ kind: "error", message: msg.error?.message ?? "Codex RPC error" }];
    }

    // Result of thread/start | thread/resume carries the thread id.
    if (msg?.result?.thread?.id) {
      this.threadId = msg.result.thread.id;
      return [{ kind: "session_init", sessionId: this.threadId! }];
    }

    if (msg?.method) return this.handleNotification(msg.method, msg.params ?? {});
    return [];
  }

  private handleNotification(method: string, params: any): ParsedEvent[] {
    switch (method) {
      case "thread/started":
        if (params?.thread?.id) this.threadId = params.thread.id;
        return this.threadId ? [{ kind: "session_init", sessionId: this.threadId }] : [];

      case "turn/started":
        this.turnState.markTurnStarted(params?.turnId ?? this.threadId ?? undefined);
        return [{ kind: "thinking", text: "" }];

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.turnState.markProgress();
        return [{ kind: "thinking", text: params?.delta ?? "" }];

      case "item/agentMessage/delta":
        this.turnState.markProgress();
        return [{ kind: "text", text: params?.delta ?? "" }];

      case "item/started":
        return this.handleItemStarted(params);

      case "item/completed":
        return this.handleItemCompleted(params);

      // A raw response item is a liveness signal (no user-visible content).
      case "rawResponseItem/completed":
        this.turnState.markProgress();
        return [{ kind: "internal_progress", source: "codex_raw_item", itemType: "rawResponseItem" }];

      // Non-fatal diagnostics surfaced by Codex.
      case "configWarning":
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
        return [
          { kind: "runtime_diagnostic", severity: "warning", source: method, message: params?.message ?? method },
        ];

      case "turn/completed":
        this.turnState.markTurnCompleted();
        if (params?.status === "failed") return [{ kind: "error", message: "Codex turn failed" }];
        if (params?.status === "interrupted") {
          return [{ kind: "error", message: "Codex turn interrupted" }, { kind: "turn_end", sessionId: this.threadId ?? undefined }];
        }
        return [{ kind: "turn_end", sessionId: this.threadId ?? undefined }];

      case "error":
        return [{ kind: "error", message: params?.message ?? "Codex error" }];

      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
        return mapCodexTelemetry(method, params);

      default:
        return [];
    }
  }

  private handleItemStarted(params: any): ParsedEvent[] {
    const t = params?.item?.type ?? params?.type;
    // A started tool item closes the steering gate until it completes.
    if (t === "commandExecution" || t === "fileChange" || t === "mcpToolCall" || t === "webSearch" || t === "collabAgentToolCall") {
      this.turnState.markToolBoundary();
    }
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_call", name: "shell", input: params?.item }];
      case "contextCompaction":
        return [{ kind: "compaction_started" }];
      case "enteredReviewMode":
        return [{ kind: "review_started" }];
      case "fileChange":
        return [{ kind: "tool_call", name: "file_change", input: params?.item }];
      case "mcpToolCall":
        return [{ kind: "tool_call", name: `mcp_${params?.item?.name ?? "tool"}`, input: params?.item }];
      case "webSearch":
        return [{ kind: "tool_call", name: "web_search", input: params?.item }];
      case "collabAgentToolCall":
        return [{ kind: "tool_call", name: "collab_tool_call", input: params?.item }];
      default:
        return [];
    }
  }

  private handleItemCompleted(params: any): ParsedEvent[] {
    const t = params?.item?.type ?? params?.type;
    // A completed tool item is a boundary that reopens steering.
    if (t === "commandExecution" || t === "mcpToolCall") {
      this.turnState.markProgress();
    }
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_output", name: "shell" }];
      case "contextCompaction":
        return [{ kind: "compaction_finished" }];
      case "exitedReviewMode":
        return [{ kind: "review_finished" }];
      case "mcpToolCall":
        return [{ kind: "tool_output", name: `mcp_${params?.item?.name ?? "tool"}` }];
      case "agentMessage":
        return [{ kind: "text", text: params?.item?.text ?? "" }];
      case "reasoning":
        return [{ kind: "thinking", text: params?.item?.text ?? "" }];
      default:
        return [];
    }
  }
}
