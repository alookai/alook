/**
 * CodexEventNormalizer — maps Codex's JSON-RPC 2.0 app-server protocol into
 * `AdapterEvent`s.
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
import type { AdapterEvent } from "../../internal/adapter.js";
import { mapCodexTelemetry } from "./telemetry.js";
import { tryParseJsonLine } from "../../internal/utils.js";

function normalizeFileChangeInput(item: any): { path?: string } {
  const paths: string[] = [];
  const seen = new Set<string>();
  const changePaths = Array.isArray(item?.changes)
    ? item.changes.map((change: any) => change?.path)
    : [];
  for (const candidate of changePaths) {
    if (typeof candidate !== "string") continue;
    const path = candidate.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0 && typeof item?.path === "string") {
    const path = item.path.trim();
    if (path) paths.push(path);
  }
  return paths.length > 0 ? { path: paths.join(", ") } : {};
}

export class CodexEventNormalizer {
  private threadId: string | null = null;
  /**
   * The active turn's id, from `turn/started`'s `params.turn.id`. Codex requires
   * it as `expectedTurnId` on a `turn/steer` (a busy-steer against the in-flight
   * turn) — without it codex rejects the steer ("missing field expectedTurnId").
   * Set on `turn/started`, cleared on `turn/completed`. Null when no turn is live
   * (then a message is a fresh `turn/start`, which takes no expectedTurnId).
   */
  private turnId: string | null = null;
  /**
   * The threadId we've already emitted `session_init` for — dedups codex's
   * double thread announcement (result + notification). See `adoptAndInit`.
   */
  private sessionInitEmittedFor: string | null = null;

  get currentSessionId(): string | null {
    return this.threadId;
  }

  /** The in-flight turn's id, or null when no turn is active. */
  get currentTurnId(): string | null {
    return this.turnId;
  }

  adoptThreadId(threadId: string | null): void {
    this.threadId = threadId;
  }

  /**
   * Emit `session_init` for `threadId` ONLY the first time this thread is seen.
   * Codex announces a thread TWICE — the `thread/start` RESULT and the
   * `thread/started` NOTIFICATION — both carrying the same id. Both must adopt
   * the id (so `currentSessionId` is set no matter which arrives first), but
   * only ONE should surface `session_init`: downstream consumers that RECORD on
   * session_init (the timeline/reset-audit recorder) would otherwise log the
   * event twice — the "two identical reset records for codex only" bug. Other
   * runtimes emit session_init once, hence codex-only. The submit-once prompt
   * latch never needed the duplicate; this dedups at the source.
   */
  private adoptAndInit(threadId: string): AdapterEvent[] {
    // One normalizer owns exactly one root thread. Codex subagents announce
    // their own threads on the same app-server stream; adopting one here would
    // redirect subsequent turn ownership away from the root session.
    if (this.threadId !== null && threadId !== this.threadId) return [];
    const firstSight = threadId !== this.sessionInitEmittedFor;
    this.threadId = threadId;
    if (!firstSight) return [];
    this.sessionInitEmittedFor = threadId;
    return [{ kind: "session_init", sessionId: threadId }];
  }

  normalizeLine(line: string): AdapterEvent[] {
    const msg = tryParseJsonLine(line) as any;
    if (!msg) return [];

    // JSON-RPC error response.
    if (msg?.error && msg.id !== undefined) {
      return [{ kind: "error", message: msg.error?.message ?? "Codex RPC error" }];
    }

    // Result of thread/start | thread/resume carries the thread id.
    if (msg?.result?.thread?.id) {
      return this.adoptAndInit(msg.result.thread.id);
    }

    if (msg?.method) return this.handleNotification(msg.method, msg.params ?? {});
    return [];
  }

  private handleNotification(method: string, params: any): AdapterEvent[] {
    const notificationThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (
      this.threadId !== null &&
      notificationThreadId !== null &&
      notificationThreadId !== this.threadId
    ) return [];

    switch (method) {
      case "thread/started":
        return params?.thread?.id ? this.adoptAndInit(params.thread.id) : [];

      case "turn/started":
        // Capture the turn id — codex needs it back as `expectedTurnId` on a
        // `turn/steer` against this turn (see CodexDriver.encodeMessage).
        if (
          typeof params?.threadId !== "string" ||
          params.threadId !== this.threadId ||
          typeof params?.turn?.id !== "string"
        ) return [];
        this.turnId = params.turn.id;
        return [{ kind: "thinking", text: "" }];

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [{ kind: "thinking", text: params?.delta ?? "" }];

      case "item/agentMessage/delta":
        return [{ kind: "text", text: params?.delta ?? "" }];

      case "item/started":
        return this.handleItemStarted(params);

      case "item/completed":
        return this.handleItemCompleted(params);

      // A raw response item is a liveness signal (no user-visible content).
      case "rawResponseItem/completed":
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
        // The app-server multiplexes root and subagent notifications. Only the
        // completion that names BOTH our root thread and current root turn may
        // clear ownership or emit the logical root terminal event.
        if (
          typeof params?.threadId !== "string" ||
          params.threadId !== this.threadId ||
          typeof params?.turn?.id !== "string" ||
          params.turn.id !== this.turnId
        ) return [];
        this.turnId = null;
        if (params.turn.status === "failed") {
          return [
            { kind: "error", message: "Codex turn failed" },
            { kind: "turn_end", sessionId: this.threadId ?? undefined },
          ];
        }
        if (params.turn.status === "interrupted") {
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

  private handleItemStarted(params: any): AdapterEvent[] {
    const t = params?.item?.type ?? params?.type;
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_call", name: "shell", input: params?.item }];
      case "contextCompaction":
        return [{ kind: "compaction_started" }];
      case "enteredReviewMode":
        return [{ kind: "review_started" }];
      case "fileChange":
        return [{ kind: "tool_call", name: "file_change", input: normalizeFileChangeInput(params?.item) }];
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

  private handleItemCompleted(params: any): AdapterEvent[] {
    const t = params?.item?.type ?? params?.type;
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_output", name: "shell" }];
      case "contextCompaction":
        return [{ kind: "compaction_finished" }];
      case "exitedReviewMode":
        return [{ kind: "review_finished" }];
      case "fileChange":
        return [{ kind: "tool_output", name: "file_change" }];
      case "mcpToolCall":
        return [{ kind: "tool_output", name: `mcp_${params?.item?.name ?? "tool"}` }];
      case "webSearch":
        return [{ kind: "tool_output", name: "web_search" }];
      case "collabAgentToolCall":
        return [{ kind: "tool_output", name: "collab_tool_call" }];
      case "agentMessage":
        return [{ kind: "text", text: params?.item?.text ?? "" }];
      case "reasoning":
        return [{ kind: "thinking", text: params?.item?.text ?? "" }];
      default:
        return [];
    }
  }
}
