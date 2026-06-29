/**
 * Agent inbox freshness state machine.
 *
 * This is the "don't reply on stale context" guard. Before an agent performs an
 * outward action (`send`, `task_claim`, `task_update`), `planAgentInboxSideEffect`
 * checks whether there are messages on the same target the model has NOT yet
 * seen. Based on monotonic `seq` boundaries it returns one of:
 *
 *   - **forward**  — nothing unseen (or `continueAnyway`); let the action through.
 *   - **held**     — unseen messages exist; hold the action, surface the latest
 *                    few as "held context" so the model can reconcile first.
 *   - (bypass)     — explicit `continueAnyway`; forwarded as `decision:"bypass"`.
 *
 * It is a PURE function: same inputs → same plan (incl. a stable
 * `producerFactId` hash). The caller applies the returned `effects`
 * (`consume_visible_messages`, `record_freshness_decision`) against real state.
 *
 * Trust:
 *   - `trusted`   — decision based on messages that exactly match the target's
 *                   pending set.
 *   - `untrusted` — first-touch case decided only from "recent" context.
 *
 * Generic, host-neutral agent inbox freshness abstraction.
 * Clause ids `SMR-002` (consume) / `SMR-006` (held envelope) preserved.
 */
import { createHash } from "crypto";

export const DEFAULT_HELD_CONTEXT_LIMIT = 3;

export type InboxAction = "send" | "task_claim" | "task_update";
export type InboxDecisionKind = "forward" | "local_hold" | "syncing_hold" | "bypass";
export type InboxTrustState = "trusted" | "untrusted";

export interface InboxVisibleMessage {
  seq?: number;
  message_id?: string;
  id?: string;
  timestamp?: string;
  createdAt?: string;
  sender_id?: string;
  senderId?: string;
  sender_type?: string;
  senderType?: string;
  sender_name?: string;
  senderName?: string;
  sender_description?: string | null;
  senderDescription?: string | null;
  [key: string]: unknown;
}

export interface PlanInput {
  agentId: string;
  action: InboxAction;
  target: string;
  continueAnyway?: boolean;
  pendingMessages: InboxVisibleMessage[];
  recentMessages: InboxVisibleMessage[];
  existingSeenUpToSeq?: number;
  modelSeenSeq?: number;
  heldContextLimit?: number;
  /** Optional escape hatch for non-seq "seen" checks. */
  isMessageModelSeen?: (arg: { target: string; message: InboxVisibleMessage }) => boolean;
}

export interface FreshnessDecision {
  action: InboxAction;
  decision: InboxDecisionKind;
  target: string;
  inboxTrustState: InboxTrustState;
  reason: string;
  pendingCount?: number;
  pendingMaxSeq?: number;
  modelSeenSeq?: number;
  heldMessageCount?: number;
  omittedMessageCount?: number;
  producerFactId?: string;
}

export type ConsumeEffect = {
  type: "consume_visible_messages";
  target: string;
  messages: InboxVisibleMessage[];
  boundarySeq?: number;
  source: "side_effect_preflight_context";
};
export type RecordDecisionEffect = { type: "record_freshness_decision"; decision: FreshnessDecision };
export type PlanEffect = ConsumeEffect | RecordDecisionEffect;

export interface TraceEntry {
  step: string;
  data?: Record<string, unknown>;
}

export interface HeldContext {
  heldMessages: InboxVisibleMessage[];
  newMessageCount: number;
  shownMessageCount: number;
  omittedMessageCount: number;
  seenUpToSeq: number;
}

export interface PlanResult {
  outcome: "forward" | "held";
  target: string;
  forwardSeenUpToSeq?: number;
  effects: PlanEffect[];
  trace: TraceEntry[];
  localResponse?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* The reducer                                                         */
/* ------------------------------------------------------------------ */

export function planAgentInboxSideEffect(input: PlanInput): PlanResult {
  const heldContextLimit = input.heldContextLimit ?? DEFAULT_HELD_CONTEXT_LIMIT;
  const trace: TraceEntry[] = [
    {
      step: "input",
      data: compactTraceData({
        action: input.action,
        target: input.target,
        continueAnyway: input.continueAnyway,
        pendingCount: input.pendingMessages.length,
        recentCount: input.recentMessages.length,
        existingSeenUpToSeq: input.existingSeenUpToSeq,
        modelSeenSeq: input.modelSeenSeq,
      }),
    },
  ];

  // Explicit override: send/act regardless.
  if (input.continueAnyway) {
    appendTrace(trace, "continue_anyway_bypass");
    return forwardPlan(
      input,
      { action: input.action, decision: "bypass", target: input.target, inboxTrustState: "trusted", reason: "continue_anyway" },
      trace,
    );
  }

  // Case 1: messages pending on the exact target.
  if (input.pendingMessages.length > 0) {
    appendTrace(trace, "pending_messages_found", { pendingCount: input.pendingMessages.length });
    const pending = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(input.pendingMessages, input.target));
    const boundary = resolveFreshnessBoundary(pending);
    if (!boundary.ok) {
      appendTrace(trace, "pending_context_missing_boundary");
      return forwardWithoutDecision(input, trace);
    }

    const alreadySeenPending: InboxVisibleMessage[] = [];
    const unconsumedMessages: InboxVisibleMessage[] = [];
    for (const message of pending) {
      if (isMessageModelSeen(input, message)) alreadySeenPending.push(message);
      else unconsumedMessages.push(message);
    }
    appendTrace(trace, "pending_context_classified", {
      pendingCount: pending.length,
      unseenCount: unconsumedMessages.length,
    });

    // 1a: everything pending is already seen → forward, advance boundary.
    if (unconsumedMessages.length === 0) {
      const contiguousBoundary = maxKnownContiguousBoundary(input);
      const canAdvanceBoundary =
        typeof contiguousBoundary === "number" && contiguousBoundary >= boundary.seenUpToSeq;
      appendTrace(trace, "pending_context_already_seen", { boundarySeq: boundary.seenUpToSeq });
      return forwardPlan(
        input,
        {
          action: input.action,
          decision: "forward",
          target: input.target,
          inboxTrustState: "trusted",
          reason: "exact_target_pending_already_seen",
          pendingCount: pending.length,
          pendingMaxSeq: boundary.seenUpToSeq,
          modelSeenSeq: contiguousBoundary,
          heldMessageCount: 0,
          omittedMessageCount: 0,
        },
        trace,
        {
          forwardSeenUpToSeq: input.action === "send" && canAdvanceBoundary ? boundary.seenUpToSeq : undefined,
          consumeEffect: {
            type: "consume_visible_messages",
            target: input.target,
            messages: exactSeenConsumeMessages(input, pending),
            boundarySeq: canAdvanceBoundary ? boundary.seenUpToSeq : undefined,
            source: "side_effect_preflight_context",
          },
        },
      );
    }

    // 1b: some unseen → HOLD, show latest few.
    const heldBoundary = resolveFreshnessBoundary(unconsumedMessages);
    if (heldBoundary.ok) {
      const heldMessages = latestVisibleMessages(unconsumedMessages, heldContextLimit);
      const omittedMessageCount = Math.max(0, unconsumedMessages.length - heldMessages.length);
      const context: HeldContext = {
        heldMessages,
        newMessageCount: unconsumedMessages.length,
        shownMessageCount: heldMessages.length,
        omittedMessageCount,
        seenUpToSeq: heldBoundary.seenUpToSeq,
      };
      appendTrace(trace, "held_context_built", {
        boundarySeq: boundary.seenUpToSeq,
        heldBoundarySeq: heldBoundary.seenUpToSeq,
        heldCount: context.shownMessageCount,
        omittedCount: context.omittedMessageCount,
      });
      return heldPlan(
        input,
        {
          decision: {
            action: input.action,
            decision: "local_hold",
            target: input.target,
            inboxTrustState: "trusted",
            reason: "exact_target_pending",
            pendingCount: input.pendingMessages.length,
            pendingMaxSeq: heldBoundary.seenUpToSeq,
            modelSeenSeq: input.modelSeenSeq,
            heldMessageCount: context.shownMessageCount,
            omittedMessageCount: context.omittedMessageCount,
          },
          context,
          consumeMessages: sortInboxMessagesBySeq([
            ...exactSeenConsumeMessages(input, alreadySeenPending),
            ...context.heldMessages,
          ]),
          consumeBoundarySeq: heldBoundary.seenUpToSeq,
        },
        trace,
      );
    }
    appendTrace(trace, "pending_unseen_context_missing_boundary");
    return forwardWithoutDecision(input, trace);
  }

  // Case 2: no pending; trust a known seq boundary if we have one.
  const boundary = Math.max(input.existingSeenUpToSeq ?? 0, input.modelSeenSeq ?? 0);
  appendTrace(trace, "model_boundary_checked", { boundary });
  if (boundary > 0) {
    appendTrace(trace, "model_boundary_selected", { boundary });
    return forwardPlan(
      input,
      {
        action: input.action,
        decision: "forward",
        target: input.target,
        inboxTrustState: "trusted",
        reason: "model_seen_boundary",
        pendingCount: 0,
        modelSeenSeq: boundary,
      },
      trace,
      { forwardSeenUpToSeq: input.action === "send" ? boundary : undefined },
    );
  }

  // Case 3: first touch — decide from "recent" context (untrusted).
  if (input.recentMessages.length > 0) {
    return planFirstTouchRecentContext(input, heldContextLimit, trace);
  }

  appendTrace(trace, "no_context_available");
  return forwardPlan(
    input,
    {
      action: input.action,
      decision: "forward",
      target: input.target,
      inboxTrustState: "trusted",
      reason: "no_exact_target_pending_or_recent_context",
      pendingCount: 0,
      modelSeenSeq: 0,
    },
    trace,
  );
}

/* ------------------------------------------------------------------ */
/* First-touch (recent context, untrusted)                            */
/* ------------------------------------------------------------------ */

function planFirstTouchRecentContext(input: PlanInput, heldContextLimit: number, trace: TraceEntry[]): PlanResult {
  const recent = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(input.recentMessages, input.target));
  const unconsumedMessages = recent.filter((message) => !isMessageModelSeen(input, message));
  appendTrace(trace, "recent_context_loaded", { recentCount: recent.length, unseenCount: unconsumedMessages.length });

  const boundary = resolveFreshnessBoundary(recent);
  if (!boundary.ok) {
    appendTrace(trace, "recent_context_missing_boundary");
    return forwardPlan(
      input,
      {
        action: input.action,
        decision: "forward",
        target: input.target,
        inboxTrustState: "untrusted",
        reason: "target_first_touch_recent_context_without_seq_boundary",
        pendingCount: 0,
        modelSeenSeq: 0,
      },
      trace,
    );
  }
  appendTrace(trace, "recent_boundary_resolved", { boundarySeq: boundary.seenUpToSeq });

  if (unconsumedMessages.length === 0) {
    appendTrace(trace, "recent_context_already_seen");
    return forwardPlan(
      input,
      {
        action: input.action,
        decision: "forward",
        target: input.target,
        inboxTrustState: "untrusted",
        reason: "target_first_touch_recent_context_already_seen",
        pendingCount: 0,
        pendingMaxSeq: boundary.seenUpToSeq,
        modelSeenSeq: boundary.seenUpToSeq,
        heldMessageCount: 0,
        omittedMessageCount: 0,
      },
      trace,
      {
        forwardSeenUpToSeq: input.action === "send" ? boundary.seenUpToSeq : undefined,
        consumeEffect: {
          type: "consume_visible_messages",
          target: input.target,
          messages: recent,
          boundarySeq: boundary.seenUpToSeq,
          source: "side_effect_preflight_context",
        },
      },
    );
  }

  const heldBoundary = resolveFreshnessBoundary(unconsumedMessages);
  if (!heldBoundary.ok) {
    appendTrace(trace, "unseen_context_missing_boundary");
    return forwardPlan(
      input,
      {
        action: input.action,
        decision: "forward",
        target: input.target,
        inboxTrustState: "untrusted",
        reason: "target_first_touch_unseen_context_without_seq_boundary",
        pendingCount: 0,
        modelSeenSeq: 0,
      },
      trace,
    );
  }
  appendTrace(trace, "unseen_boundary_resolved", { boundarySeq: heldBoundary.seenUpToSeq });

  const heldMessages = latestVisibleMessages(unconsumedMessages, heldContextLimit);
  const omittedMessageCount = Math.max(0, unconsumedMessages.length - heldMessages.length);
  appendTrace(trace, "unseen_hold_selected", {
    heldCount: heldMessages.length,
    omittedCount: omittedMessageCount,
    consumeBoundarySeq: boundary.seenUpToSeq,
  });
  return heldPlan(
    input,
    {
      decision: {
        action: input.action,
        decision: "syncing_hold",
        target: input.target,
        inboxTrustState: "untrusted",
        reason: "target_first_touch_recent_context",
        pendingCount: 0,
        pendingMaxSeq: heldBoundary.seenUpToSeq,
        modelSeenSeq: 0,
        heldMessageCount: heldMessages.length,
        omittedMessageCount,
      },
      context: {
        heldMessages,
        newMessageCount: unconsumedMessages.length,
        shownMessageCount: heldMessages.length,
        omittedMessageCount,
        seenUpToSeq: boundary.seenUpToSeq,
      },
      consumeMessages: recent,
      consumeBoundarySeq: boundary.seenUpToSeq,
    },
    trace,
  );
}

/* ------------------------------------------------------------------ */
/* Plan builders                                                       */
/* ------------------------------------------------------------------ */

function heldPlan(
  input: PlanInput,
  held: { decision: FreshnessDecision; context: HeldContext; consumeMessages: InboxVisibleMessage[]; consumeBoundarySeq: number },
  trace: TraceEntry[],
): PlanResult {
  const producerFactId = buildApmFreshnessDecisionProducerFactId(input.agentId, held.decision);
  const decision = { ...held.decision, producerFactId };
  appendTrace(trace, "plan_built", {
    outcome: "held",
    decision: decision.decision,
    effectCount: 2,
    localResponseState: "held",
    seenUpToSeq: held.context.seenUpToSeq,
  });
  return {
    outcome: "held",
    target: input.target,
    effects: [
      {
        type: "consume_visible_messages",
        target: input.target,
        messages: held.consumeMessages,
        boundarySeq: held.consumeBoundarySeq,
        source: "side_effect_preflight_context",
      },
      { type: "record_freshness_decision", decision },
    ],
    trace,
    localResponse: projectApmHeldFreshnessEnvelope({
      producerFactId,
      action: input.action,
      heldMessages: held.context.heldMessages,
      newMessageCount: held.context.newMessageCount,
      omittedMessageCount: held.context.omittedMessageCount,
      seenUpToSeq: held.context.seenUpToSeq,
    }).body,
  };
}

function forwardPlan(
  input: PlanInput,
  decision: FreshnessDecision,
  trace: TraceEntry[],
  options: { forwardSeenUpToSeq?: number; consumeEffect?: ConsumeEffect } = {},
): PlanResult {
  appendTrace(trace, "plan_built", {
    outcome: "forward",
    decision: decision.decision,
    effectCount: options.consumeEffect ? 2 : 1,
    forwardSeenUpToSeq: options.forwardSeenUpToSeq,
  });
  return {
    outcome: "forward",
    target: input.target,
    forwardSeenUpToSeq: options.forwardSeenUpToSeq,
    effects: [
      ...(options.consumeEffect ? [options.consumeEffect] : []),
      { type: "record_freshness_decision", decision },
    ],
    trace,
  };
}

function forwardWithoutDecision(input: PlanInput, trace: TraceEntry[]): PlanResult {
  appendTrace(trace, "plan_built", { outcome: "forward", decision: "none", effectCount: 0 });
  return { outcome: "forward", target: input.target, effects: [], trace };
}

/* ------------------------------------------------------------------ */
/* Normalization & seq helpers                                         */
/* ------------------------------------------------------------------ */

export function normalizeInboxVisibleMessage(message: InboxVisibleMessage, target?: string): InboxVisibleMessage {
  const targetFields = target ? parseTargetFields(target) : {};
  const normalized: InboxVisibleMessage = {
    ...targetFields,
    ...message,
    message_id: message.message_id ?? message.id,
    timestamp: message.timestamp ?? message.createdAt,
    sender_type: message.sender_type ?? message.senderType,
    sender_name: message.sender_name ?? message.senderName,
    sender_description: message.sender_description ?? message.senderDescription ?? null,
  };
  const senderId = messageSenderId(message);
  if (senderId) normalized.sender_id = senderId;
  return normalized;
}

function normalizeInboxVisibleMessages(messages: InboxVisibleMessage[], target?: string): InboxVisibleMessage[] {
  return messages.map((message) => normalizeInboxVisibleMessage(message, target));
}

function maxInboxMessageSeq(messages: InboxVisibleMessage[]): number | undefined {
  let maxSeq = 0;
  for (const message of messages) {
    const seq = Math.floor(messageSeq(message));
    if (Number.isFinite(seq) && seq > 0) maxSeq = Math.max(maxSeq, seq);
  }
  return maxSeq > 0 ? maxSeq : undefined;
}

function maxKnownContiguousBoundary(input: PlanInput): number | undefined {
  const boundary = Math.max(input.existingSeenUpToSeq ?? 0, input.modelSeenSeq ?? 0);
  return boundary > 0 ? boundary : undefined;
}

/**
 * For messages at/under the known contiguous boundary, consume by seq;
 * otherwise consume by id (drop the seq) so we don't wrongly advance.
 */
function exactSeenConsumeMessages(input: PlanInput, messages: InboxVisibleMessage[]): InboxVisibleMessage[] {
  const boundary = maxKnownContiguousBoundary(input);
  return messages.map((message) => {
    const seq = Math.floor(messageSeq(message));
    if (Number.isFinite(seq) && seq > 0 && typeof boundary === "number" && boundary >= seq) return message;
    const id =
      typeof message.message_id === "string" && message.message_id.length > 0
        ? message.message_id
        : typeof message.id === "string" && message.id.length > 0
          ? message.id
          : undefined;
    return id ? { ...message, seq: undefined } : message;
  });
}

function sortInboxMessagesBySeq(messages: InboxVisibleMessage[]): InboxVisibleMessage[] {
  return [...messages].sort((a, b) => messageSeq(a) - messageSeq(b));
}

function latestVisibleMessages(messages: InboxVisibleMessage[], limit: number): InboxVisibleMessage[] {
  const sorted = sortInboxMessagesBySeq(messages);
  return sorted.slice(Math.max(0, sorted.length - limit));
}

function resolveFreshnessBoundary(
  messages: InboxVisibleMessage[],
): { ok: true; seenUpToSeq: number } | { ok: false; reason: string } {
  const seenUpToSeq = maxInboxMessageSeq(messages);
  return typeof seenUpToSeq === "number" ? { ok: true, seenUpToSeq } : { ok: false, reason: "missing_seq_boundary" };
}

function isMessageModelSeen(input: PlanInput, message: InboxVisibleMessage): boolean {
  const seq = Math.floor(messageSeq(message));
  if (Number.isFinite(seq) && seq > 0 && typeof input.modelSeenSeq === "number" && input.modelSeenSeq >= seq) {
    return true;
  }
  return input.isMessageModelSeen?.({ target: input.target, message }) === true;
}

function messageSeq(message: InboxVisibleMessage): number {
  return Number(message.seq ?? 0);
}

function messageSenderId(message: InboxVisibleMessage): string | undefined {
  if (typeof message.sender_id === "string" && message.sender_id.length > 0) return message.sender_id;
  if (typeof message.senderId === "string" && message.senderId.length > 0) return message.senderId;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Target parsing                                                      */
/* ------------------------------------------------------------------ */

function parseTargetFields(target: string): Record<string, string> {
  if (target.startsWith("dm:@")) {
    const rest = target.slice("dm:@".length);
    const [peer, threadId] = rest.split(":", 2);
    if (threadId) {
      return { channel_type: "thread", channel_name: threadId, parent_channel_type: "dm", parent_channel_name: peer };
    }
    return { channel_type: "dm", channel_name: peer };
  }
  if (target.startsWith("#")) {
    const rest = target.slice(1);
    const [channel, threadId] = rest.split(":", 2);
    if (threadId) {
      return {
        channel_type: "thread",
        channel_name: threadId,
        parent_channel_type: "channel",
        parent_channel_name: channel,
      };
    }
    return { channel_type: "channel", channel_name: channel };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Held-envelope projection + stable producer-fact hashing             */
/* ------------------------------------------------------------------ */

export interface HeldFreshnessEnvelope {
  clauseId: "SMR-006";
  projector: "held-envelope";
  surface: "agent-api-held-response";
  producerFactId: string;
  body: Record<string, unknown>;
}

function apmHeldFreshnessAvailableActions(action: InboxAction): string[] {
  return action === "send"
    ? ["check_messages", "send_draft", "send_anyway"]
    : ["check_messages", "retry_action"];
}

export function projectApmHeldFreshnessEnvelope(input: {
  producerFactId: string;
  action: InboxAction;
  heldMessages: InboxVisibleMessage[];
  newMessageCount: number;
  omittedMessageCount: number;
  seenUpToSeq: number;
}): HeldFreshnessEnvelope {
  const body = {
    state: "held",
    outcome: "held",
    subtype: "freshness",
    reason: "newer_messages_available",
    producerFactId: input.producerFactId,
    available_actions: apmHeldFreshnessAvailableActions(input.action),
    heldMessages: input.heldMessages,
    newMessageCount: input.newMessageCount,
    shownMessageCount: input.heldMessages.length,
    omittedMessageCount: input.omittedMessageCount,
    seenUpToSeq: input.seenUpToSeq,
  };
  return {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "agent-api-held-response",
    producerFactId: input.producerFactId,
    body,
  };
}

export function buildApmFreshnessDecisionProducerFactId(agentId: string, input: FreshnessDecision): string {
  const stableInput = {
    agentId,
    action: input.action,
    decision: input.decision,
    target: input.target ?? null,
    reason: input.reason,
    pendingMaxSeq: input.pendingMaxSeq ?? null,
    modelSeenSeq: input.modelSeenSeq ?? null,
    heldMessageCount: input.heldMessageCount ?? null,
    omittedMessageCount: input.omittedMessageCount ?? null,
  };
  return `freshness_decision_fact:${hashApmHeldFreshnessStable(stableInput)}`;
}

function hashApmHeldFreshnessStable(value: unknown): string {
  return createHash("sha256").update(stableStringifyApmHeldFreshness(value)).digest("hex");
}

function stableStringifyApmHeldFreshness(value: unknown): string {
  return JSON.stringify(stableNormalizeApmHeldFreshness(value));
}

function stableNormalizeApmHeldFreshness(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalizeApmHeldFreshness(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    normalized[key] = stableNormalizeApmHeldFreshness(record[key]);
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* Trace helpers                                                       */
/* ------------------------------------------------------------------ */

function appendTrace(trace: TraceEntry[], step: string, data?: Record<string, unknown>): void {
  const compacted = compactTraceData(data);
  trace.push(Object.keys(compacted).length > 0 ? { step, data: compacted } : { step });
}

function compactTraceData(data?: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  if (!data) return compacted;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}
