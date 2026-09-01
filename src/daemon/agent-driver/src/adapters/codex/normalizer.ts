import type { AdapterEvent } from "../../internal/adapter.js";
import { mapCodexQuotaSnapshots, mapCodexSettledUsage } from "./telemetry.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { tryParseJsonLine } from "../../internal/utils.js";
import { randomBytes } from "node:crypto";

let codexQuotaSourceEpoch = randomBytes(16).toString("base64url");
let codexQuotaSourceGeneration = 0;
let codexAccountFingerprint: string | null = null;

const CODEX_ERROR_INFO_CODES = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
]);

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function codexErrorInfoCode(value: unknown, fallback: string): string {
  const label = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)[0]
      : undefined;
  return label && CODEX_ERROR_INFO_CODES.has(label)
    ? `codex.${snakeCase(label)}`
    : fallback;
}

function codexRpcErrorCode(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? `codex.rpc.${value}`
    : "codex.rpc_error";
}

function rotateCodexQuotaSource(): void {
  codexQuotaSourceEpoch = randomBytes(16).toString("base64url");
  codexQuotaSourceGeneration += 1;
  codexAccountFingerprint = null;
}

function observeCodexAccount(result: any): void {
  const account = result?.account;
  const fingerprint = account && typeof account === "object"
    ? JSON.stringify([
        account.type ?? "unknown",
        account.email ?? null,
        account.planType ?? account.plan_type ?? null,
      ])
    : "none";
  if (codexAccountFingerprint !== null && codexAccountFingerprint !== fingerprint) {
    rotateCodexQuotaSource();
  }
  codexAccountFingerprint = fingerprint;
}

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
  private readonly quotaReadRequestIds = new Set<number>();
  private readonly accountReadRequestIds = new Set<number>();
  private readonly rateLimitSnapshots = new Map<string, Record<string, unknown>>();
  private quotaSnapshotInitialized = false;
  private quotaSourceGeneration = codexQuotaSourceGeneration;
  private readonly usageProjector = new SettledUsageProjector();
  private readonly usageRecordsBySessionAndTurn = new Map<string, Map<string, Set<string>>>();
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

  registerQuotaReadRequest(requestId: number): void {
    this.quotaReadRequestIds.add(requestId);
  }

  registerAccountReadRequest(requestId: number): void {
    this.accountReadRequestIds.add(requestId);
  }

  private syncQuotaSourceGeneration(): void {
    if (this.quotaSourceGeneration === codexQuotaSourceGeneration) return;
    this.quotaSourceGeneration = codexQuotaSourceGeneration;
    this.rateLimitSnapshots.clear();
    this.quotaSnapshotInitialized = false;
  }

  private quotaSnapshots(value: any): Array<[string, Record<string, unknown>]> {
    const byLimitId = value?.rateLimitsByLimitId ?? value?.rate_limits_by_limit_id;
    if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
      return Object.entries(byLimitId).flatMap(([key, snapshot]) => {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
        return [[key, {
          ...(snapshot as Record<string, unknown>),
          limitId: (snapshot as Record<string, unknown>).limitId
            ?? (snapshot as Record<string, unknown>).limit_id
            ?? key,
        }]];
      });
    }
    const snapshot = value?.rateLimits ?? value?.rate_limits ?? value;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
    const record = snapshot as Record<string, unknown>;
    const key = typeof record.limitId === "string"
      ? record.limitId
      : typeof record.limit_id === "string"
        ? record.limit_id
        : "codex";
    return [[key, { ...record, limitId: key }]];
  }

  private replaceQuotaSnapshots(value: any): AdapterEvent[] {
    this.syncQuotaSourceGeneration();
    this.rateLimitSnapshots.clear();
    for (const [key, snapshot] of this.quotaSnapshots(value)) {
      this.rateLimitSnapshots.set(key, snapshot);
    }
    this.quotaSnapshotInitialized = true;
    return [mapCodexQuotaSnapshots([...this.rateLimitSnapshots.values()], codexQuotaSourceEpoch)];
  }

  private mergeQuotaSnapshots(value: any): AdapterEvent[] {
    this.syncQuotaSourceGeneration();
    for (const [key, update] of this.quotaSnapshots(value)) {
      const merged: Record<string, unknown> = {
        ...(this.rateLimitSnapshots.get(key) ?? {}),
        limitId: key,
      };
      for (const [field, fieldValue] of Object.entries(update)) {
        if (fieldValue !== undefined && fieldValue !== null) merged[field] = fieldValue;
      }
      this.rateLimitSnapshots.set(key, merged);
    }
    if (!this.quotaSnapshotInitialized) return [];
    return [mapCodexQuotaSnapshots([...this.rateLimitSnapshots.values()], codexQuotaSourceEpoch)];
  }

  adoptThreadId(threadId: string | null): void {
    if (threadId !== this.threadId) {
      this.turnId = null;
      this.terminalTurn = null;
      this.usageProjector.reset();
      this.usageRecordsBySessionAndTurn.clear();
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

    if (msg?.id !== undefined && this.accountReadRequestIds.delete(msg.id)) {
      if (!msg.error) {
        observeCodexAccount(msg.result);
        this.syncQuotaSourceGeneration();
      }
      return [];
    }

    if (msg?.id !== undefined && this.quotaReadRequestIds.delete(msg.id)) {
      this.syncQuotaSourceGeneration();
      if (msg.error) {
        return [{
          kind: "telemetry",
          name: "rate_limits",
          source: "codex_account_rate_limits_read",
          quota: { status: "error", sourceEpoch: codexQuotaSourceEpoch, code: "provider_error", retryable: true },
        }];
      }
      return this.replaceQuotaSnapshots(msg.result ?? {});
    }

    if (msg?.error && msg.id !== undefined) {
      return [{
        kind: "error",
        code: codexRpcErrorCode(msg.error?.code),
        message: msg.error?.message ?? "Codex RPC error",
      }];
    }

    if (msg?.result?.thread?.id) {
      return this.adoptAndInit(msg.result.thread.id);
    }

    if (msg?.method) return this.handleNotification(msg.method, msg.params ?? {});
    return [];
  }

  private handleNotification(method: string, params: any): AdapterEvent[] {
    const notificationThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (method === "rawResponse/completed") return this.handleSettledUsage(params);
    if (
      method === "turn/completed"
      && notificationThreadId !== null
      && notificationThreadId !== this.threadId
    ) {
      const turnId = this.notificationTurnId(params);
      if (turnId) this.releaseUsageForTurn(notificationThreadId, turnId);
      return [];
    }
    if (
      method === "item/completed"
      && notificationThreadId !== null
      && notificationThreadId !== this.threadId
    ) {
      const turnId = this.notificationTurnId(params);
      const itemType = params?.item?.type ?? params?.type;
      if (turnId && itemType === "contextCompaction") {
        this.releaseUsageForTurn(notificationThreadId, turnId);
      }
      return [];
    }
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
        ];

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [{ kind: "assistant_reasoning_delta", text: params?.delta ?? "" }];

      case "item/agentMessage/delta":
        return [{ kind: "assistant_message_delta", text: params?.delta ?? "" }];

      case "item/started":
        return this.handleItemStarted(params);

      case "item/completed":
        return this.handleItemCompletedAndReleaseUsage(params);

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
        this.releaseUsageForTurn(params.threadId, params.turn.id);
        if (params.turn.status === "failed") {
          const error = params.turn.error;
          return [
            {
              kind: "error",
              code: codexErrorInfoCode(error?.codexErrorInfo, "codex.turn_failed"),
              message: error?.message ?? "Codex turn failed",
            },
            { kind: "turn_end", sessionId: this.threadId ?? undefined, turnOwner: this.turnReceipt(params.threadId, params.turn.id) },
          ];
        }
        return [{ kind: "turn_end", sessionId: this.threadId ?? undefined, turnOwner: this.turnReceipt(params.threadId, params.turn.id) }];

      case "error":
        if (params?.willRetry === true) {
          return [{ kind: "runtime_recovery", stage: "retrying", source: "codex_stream" }];
        }
        return [{
          kind: "error",
          code: codexErrorInfoCode(params?.error?.codexErrorInfo, "codex.error"),
          message: params?.error?.message ?? params?.message ?? "Codex error",
        }];

      case "thread/tokenUsage/updated":
        return [];
      case "account/rateLimits/updated":
        return this.mergeQuotaSnapshots(params);
      case "account/updated":
        rotateCodexQuotaSource();
        this.syncQuotaSourceGeneration();
        return [];

      default:
        return [];
    }
  }

  private handleSettledUsage(params: any): AdapterEvent[] {
    const notificationTurnId = this.notificationTurnId(params);
    if (
      this.turnId === null
      && this.terminalTurn?.state === "closed"
      && notificationTurnId === this.terminalTurn.turnId
      && params?.threadId === this.terminalTurn.threadId
    ) return [];
    const backendSessionId = params?.threadId ?? params?.thread_id;
    const providerRecordId = params?.responseId ?? params?.response_id;
    if (
      !notificationTurnId
      || typeof backendSessionId !== "string"
      || typeof providerRecordId !== "string"
    ) return [];
    const usage = mapCodexSettledUsage(params, this.usageProjector);
    if (!usage) return [];
    const recordsByTurn = this.usageRecordsBySessionAndTurn.get(backendSessionId) ?? new Map<string, Set<string>>();
    const recordIds = recordsByTurn.get(notificationTurnId) ?? new Set<string>();
    recordIds.add(providerRecordId);
    recordsByTurn.set(notificationTurnId, recordIds);
    this.usageRecordsBySessionAndTurn.set(backendSessionId, recordsByTurn);
    return [usage];
  }

  private releaseUsageForTurn(backendSessionId: string, turnId: string): void {
    const recordsByTurn = this.usageRecordsBySessionAndTurn.get(backendSessionId);
    for (const providerRecordId of recordsByTurn?.get(turnId) ?? []) {
      this.usageProjector.release({ runtime: "codex", backendSessionId, providerRecordId });
    }
    recordsByTurn?.delete(turnId);
    if (recordsByTurn?.size === 0) this.usageRecordsBySessionAndTurn.delete(backendSessionId);
  }

  private handleItemCompletedAndReleaseUsage(params: any): AdapterEvent[] {
    const events = this.handleItemCompleted(params);
    const turnId = this.notificationTurnId(params);
    const itemType = params?.item?.type ?? params?.type;
    if (
      turnId
      && itemType === "contextCompaction"
      && turnId !== this.turnId
      && typeof params?.threadId === "string"
    ) {
      this.releaseUsageForTurn(params.threadId, turnId);
    }
    return events;
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
    const callId = this.itemCallId(params);
    const identity = callId ? { callId } : {};
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_call", ...identity, name: "shell", input: params?.item }];
      case "contextCompaction":
        return [{ kind: "compaction_started" }];
      case "enteredReviewMode":
        return [{ kind: "review_started" }];
      case "fileChange":
        return [{ kind: "tool_call", ...identity, name: "file_change", input: normalizeFileChangeInput(params?.item) }];
      case "mcpToolCall":
        return [{ kind: "tool_call", ...identity, name: `mcp_${params?.item?.tool ?? params?.item?.name ?? "tool"}`, input: params?.item }];
      case "webSearch":
        return [{ kind: "tool_call", ...identity, name: "web_search", input: params?.item }];
      case "collabAgentToolCall":
        return [{ kind: "tool_call", ...identity, name: "collab_tool_call", input: params?.item }];
      default:
        return [];
    }
  }

  private handleItemCompleted(params: any): AdapterEvent[] {
    const t = params?.item?.type ?? params?.type;
    const callId = this.itemCallId(params);
    const identity = callId ? { callId } : {};
    switch (t) {
      case "commandExecution":
        return [{ kind: "tool_output", ...identity, name: "shell" }];
      case "contextCompaction":
        return [{ kind: "compaction_finished" }];
      case "exitedReviewMode":
        return [{ kind: "review_finished" }];
      case "fileChange":
        return [{ kind: "tool_output", ...identity, name: "file_change" }];
      case "mcpToolCall":
        return [{ kind: "tool_output", ...identity, name: `mcp_${params?.item?.tool ?? params?.item?.name ?? "tool"}` }];
      case "webSearch":
        return [{ kind: "tool_output", ...identity, name: "web_search" }];
      case "collabAgentToolCall":
        return [{ kind: "tool_output", ...identity, name: "collab_tool_call" }];
      case "agentMessage":
        return [{ kind: "assistant_message_completed", text: params?.item?.text ?? "" }];
      case "reasoning":
        return [{ kind: "assistant_reasoning_completed", text: params?.item?.text ?? "" }];
      default:
        return [];
    }
  }

  private itemCallId(params: any): string | undefined {
    const value = params?.item?.id ?? params?.itemId;
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }
}
