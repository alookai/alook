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
  private turnId: string | null = null;
  /**
   * A completed root vendor turn remains an ownership fence until Codex starts
   * another root turn. Codex can rarely report proven work after its first
   * terminal notification. In that consistency-recovery case the matching
   * work reopens this tombstone and one matching terminal may close it again.
   * Keeping this separate from `turnId` is intentional: there is no live turn
   * to steer after the first completion.
   */
  private terminalTurn: {
    threadId: string;
    turnId: string;
    state: "closed" | "reopened_after_terminal";
  } | null = null;
  private sessionInitEmittedFor: string | null = null;

  get currentSessionId(): string | null {
    return this.threadId;
  }

  get currentTurnId(): string | null {
    return this.turnId;
  }

  adoptThreadId(threadId: string | null): void {
    if (threadId !== this.threadId) {
      this.turnId = null;
      this.terminalTurn = null;
    }
    this.threadId = threadId;
  }

  private adoptAndInit(threadId: string): AdapterEvent[] {
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

    if (msg?.error && msg.id !== undefined) {
      return [{ kind: "error", message: msg.error?.message ?? "Codex RPC error" }];
    }

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
    if (this.isRootWorkNotification(method) && !this.acceptRootWork(params)) return [];

    switch (method) {
      case "thread/started":
        return params?.thread?.id ? this.adoptAndInit(params.thread.id) : [];

      case "turn/started":
        if (
          typeof params?.threadId !== "string" ||
          params.threadId !== this.threadId ||
          typeof params?.turn?.id !== "string"
        ) return [];
        this.turnId = params.turn.id;
        this.terminalTurn = null;
        return [
          {
            kind: "turn_owner",
            receipt: this.turnReceipt(params.threadId, params.turn.id),
            nativeTurnId: params.turn.id,
          },
          { kind: "thinking", text: "" },
        ];

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [{ kind: "thinking", text: params?.delta ?? "" }];

      case "item/agentMessage/delta":
        return [{ kind: "text", text: params?.delta ?? "" }];

      case "item/started":
        return this.handleItemStarted(params);

      case "item/completed":
        return this.handleItemCompleted(params);

      case "rawResponseItem/completed":
        return [{ kind: "internal_progress", source: "codex_raw_item", itemType: "rawResponseItem" }];

      case "configWarning":
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
        return [
          { kind: "runtime_diagnostic", severity: "warning", source: method, message: params?.message ?? method },
        ];

      case "turn/completed":
        if (!this.acceptRootTerminal(params)) return [];
        if (params.turn.status === "failed") {
          return [
            { kind: "error", message: "Codex turn failed" },
            { kind: "turn_end", sessionId: this.threadId ?? undefined, turnOwner: this.turnReceipt(params.threadId, params.turn.id) },
          ];
        }
        if (params.turn.status === "interrupted") {
          return [{ kind: "error", message: "Codex turn interrupted" }, { kind: "turn_end", sessionId: this.threadId ?? undefined, turnOwner: this.turnReceipt(params.threadId, params.turn.id) }];
        }
        return [{ kind: "turn_end", sessionId: this.threadId ?? undefined, turnOwner: this.turnReceipt(params.threadId, params.turn.id) }];

      case "error":
        if (params?.willRetry === true) {
          return [{ kind: "runtime_recovery", stage: "retrying", source: "codex_stream" }];
        }
        return [{ kind: "error", message: params?.error?.message ?? params?.message ?? "Codex error" }];

      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
        return mapCodexTelemetry(method, params);

      default:
        return [];
    }
  }

  private isRootWorkNotification(method: string): boolean {
    return method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
      || method === "item/agentMessage/delta"
      || method === "item/started"
      || method === "item/completed"
      || method === "rawResponseItem/completed";
  }

  private notificationTurnId(params: any): string | null {
    if (typeof params?.turnId === "string") return params.turnId;
    return typeof params?.turn?.id === "string" ? params.turn.id : null;
  }

  private turnReceipt(threadId: string, turnId: string): string {
    return `codex:${threadId}:${turnId}`;
  }

  private acceptRootWork(params: any): boolean {
    const notificationThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    const notificationTurnId = this.notificationTurnId(params);
    if (this.turnId !== null) {
      return (notificationThreadId === null || notificationThreadId === this.threadId)
        && (notificationTurnId === null || notificationTurnId === this.turnId);
    }
    if (this.terminalTurn) {
      if (
        notificationThreadId !== this.terminalTurn.threadId
        || notificationTurnId !== this.terminalTurn.turnId
      ) return false;
      this.terminalTurn.state = "reopened_after_terminal";
      return true;
    }
    // Parser-only callers may normalize isolated fixture lines before a root
    // thread is adopted. Once ownership exists, work without a live or closed
    // root turn is not attributable and must not cross the adapter boundary.
    return this.threadId === null;
  }

  private acceptRootTerminal(params: any): boolean {
    const notificationThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    const notificationTurnId = this.notificationTurnId(params);
    if (
      notificationThreadId === null
      || notificationThreadId !== this.threadId
      || notificationTurnId === null
    ) return false;
    if (notificationTurnId === this.turnId) {
      this.turnId = null;
      this.terminalTurn = {
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        state: "closed",
      };
      return true;
    }
    const terminalTurn = this.terminalTurn;
    if (
      this.turnId === null
      && terminalTurn !== null
      && terminalTurn.threadId === notificationThreadId
      && terminalTurn.turnId === notificationTurnId
      && terminalTurn.state === "reopened_after_terminal"
    ) {
      terminalTurn.state = "closed";
      return true;
    }
    return false;
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
