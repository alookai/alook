import { useEffect, useRef } from "react";
import type { Artifact, Message, TaskApi as Task } from "@alook/shared";

type EventIconType = "issue" | "email" | "calendar";

export function getEventIconType(
  content: string,
  conversationType?: string | null,
): EventIconType {
  if (conversationType === "issue_event") return "issue";
  if (conversationType === "email_notification") return "email";
  if (conversationType === "calendar_event") return "calendar";

  const lower = content.toLowerCase();
  if (lower.startsWith("issue ") || lower.startsWith("issue:")) return "issue";
  if (lower.includes("email")) return "email";
  return "calendar";
}

/**
 * Classify a system-event message by its metadata resource id first (reliable,
 * stamped at all creation sites), falling back to the content/conversationType
 * heuristic only when no id is present. Drives both the card icon and label.
 */
export function eventTypeFromMessage(
  metadata: Record<string, unknown> | null | undefined,
  content: string,
  conversationType?: string | null,
): EventIconType {
  if (metadata?.issueId) return "issue";
  if (metadata?.emailId) return "email";
  if (metadata?.calendarEventId) return "calendar";
  return getEventIconType(content, conversationType);
}

/** Sort messages by (created_at, id) ascending — guarantees chronological order. */
export function sortMessages(msgs: Message[]): Message[] {
  return msgs.slice().sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });
}

/** Merge two message arrays by ID (latest wins), then sort chronologically. */
export function mergeMessages(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const m of existing) merged.set(m.id, m);
  for (const m of incoming) merged.set(m.id, m);
  return sortMessages([...merged.values()]);
}

const NON_BRANCHABLE_MESSAGE_KINDS = new Set([
  "event",
  "lifecycle",
  "process",
  "progress",
  "status",
  "transient",
  "typing",
]);

export function isBranchableMessage(
  message: Message,
): boolean {
  const status = message.status as string | undefined;
  if (status && status !== "active") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;

  const kind =
    typeof message.metadata?.kind === "string"
      ? message.metadata.kind.toLowerCase()
      : null;
  if (kind && NON_BRANCHABLE_MESSAGE_KINDS.has(kind)) return false;
  if (message.metadata?.transient === true) return false;
  if (message.metadata?.error_source) return false;
  if (message.role === "assistant") return kind === null || kind === "dm";

  return true;
}

export function getLatestBranchableMessageId(
  messages: Message[],
  activeTaskId?: string | null,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (activeTaskId && messages[i].role === "user") continue;
    if (activeTaskId && messages[i].task_id === activeTaskId) continue;
    if (isBranchableMessage(messages[i])) return messages[i].id;
  }
  return null;
}

export function isMessageBranchActionCandidate({
  message,
  isTaskActive,
  activeBranchRootMessageId,
  hasExistingBranch,
}: {
  message: Message;
  isTaskActive: boolean;
  activeBranchRootMessageId: string | null;
  hasExistingBranch: boolean;
}): boolean {
  if (!isBranchableMessage(message)) return false;
  if (!isTaskActive) return true;
  return hasExistingBranch || message.id === activeBranchRootMessageId;
}

export function getBranchReturnTarget({
  agentId,
  conversationId,
  message,
  fallbackTaskId,
}: {
  agentId: string;
  conversationId: string;
  message: Message;
  fallbackTaskId?: string | null;
}) {
  return {
    agentId,
    conversationId,
    taskId: message.task_id ?? fallbackTaskId ?? null,
    messageId: message.id,
  };
}

export type NapMarker = { agentName: string; created_at: string; id: string };

type TimelineItem =
  | { kind: "message"; data: Message }
  | { kind: "artifact"; data: Artifact }
  | { kind: "nap"; data: NapMarker };

export type GroupPosition = "first" | "middle" | "last" | "solo";

// Which conversational SIDE a timeline item belongs to. Items on the same side
// that are adjacent (within the time threshold, no nap between) form one
// Slack/Discord-style cluster sharing a single avatar + name header. The agent
// side intentionally includes event cards (email/issue/calendar) and artifacts
// (files), so a run like "card → reply → card → reply" reads as ONE Gwennie
// cluster with one header — not four separate avatars.
type GroupSide = "user" | "agent" | null;

function groupSideOf(item: TimelineItem): GroupSide {
  if (item.kind === "artifact") return "agent"; // files come from the agent
  if (item.kind !== "message") return null; // nap markers break clusters
  const role = item.data.role;
  if (role === "user") return "user";
  if (role === "assistant" || role === "event") return "agent";
  return null;
}

function itemCreatedAt(item: TimelineItem): string | undefined {
  return item.data.created_at;
}

export function computeGroupPositions(
  timeline: TimelineItem[],
): (GroupPosition | null)[] {
  const positions: (GroupPosition | null)[] = new Array(timeline.length).fill(
    null,
  );
  const GROUP_THRESHOLD_MS = 60_000;

  const adjacentSameCluster = (a: TimelineItem | null, b: TimelineItem | null) => {
    if (!a || !b) return false;
    const sa = groupSideOf(a);
    const sb = groupSideOf(b);
    if (sa === null || sa !== sb) return false;
    const ta = itemCreatedAt(a);
    const tb = itemCreatedAt(b);
    if (!ta || !tb) return true; // missing timestamp → don't split the cluster
    return Math.abs(new Date(ta).getTime() - new Date(tb).getTime()) < GROUP_THRESHOLD_MS;
  };

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (groupSideOf(item) === null) continue; // nap → leave null

    const prev = i > 0 ? timeline[i - 1] : null;
    const next = i < timeline.length - 1 ? timeline[i + 1] : null;

    const sameAsPrev = adjacentSameCluster(prev, item);
    const sameAsNext = adjacentSameCluster(item, next);

    if (sameAsPrev && sameAsNext) positions[i] = "middle";
    else if (sameAsPrev && !sameAsNext) positions[i] = "last";
    else if (!sameAsPrev && sameAsNext) positions[i] = "first";
    else positions[i] = "solo";
  }

  return positions;
}

export function buildTimeline(
  messages: Message[],
  artifacts: Artifact[],
  napMarkers: NapMarker[],
  currentConversationId?: string | null,
): TimelineItem[] {
  if (!currentConversationId || napMarkers.length === 0) {
    const items: TimelineItem[] = [
      ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...artifacts.map((a): TimelineItem => ({ kind: "artifact", data: a })),
      ...napMarkers.map((n): TimelineItem => ({ kind: "nap", data: n })),
    ];
    items.sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind === "nap" || b.kind === "nap") {
        if (a.kind === "nap" && b.kind !== "nap") return 1;
        if (a.kind !== "nap" && b.kind === "nap") return -1;
      }
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    // Strictly chronological — a file uploaded mid-task stays where it appeared
    // and the agent's reply follows below it in the same cluster (no reorder, so
    // nothing jumps when the reply lands). Gus's call, 2026-06-01.
    return items;
  }

  const napConvIds = new Set(napMarkers.map((n) => n.id.replace(/^nap-/, "")));
  const sortedNaps = [...napMarkers].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  const groupItems = (convId: string): TimelineItem[] => {
    const msgs: TimelineItem[] = messages
      .filter((m) => m.conversation_id === convId)
      .map((m) => ({ kind: "message" as const, data: m }));
    const arts: TimelineItem[] = artifacts
      .filter((a) => a.conversation_id === convId)
      .map((a) => ({ kind: "artifact" as const, data: a }));
    const sorted = [...msgs, ...arts].sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    return sorted; // chronological, no artifact reorder (see above)
  };

  const result: TimelineItem[] = [];

  for (const nap of sortedNaps) {
    const convId = nap.id.replace(/^nap-/, "");
    result.push(...groupItems(convId));
    result.push({ kind: "nap", data: nap });
  }

  result.push(...groupItems(currentConversationId));

  const knownConvIds = new Set([...napConvIds, currentConversationId]);
  const orphanMsgs = messages.filter(
    (m) => !knownConvIds.has(m.conversation_id),
  );
  const orphanArts = artifacts.filter(
    (a) => !knownConvIds.has(a.conversation_id),
  );
  if (orphanMsgs.length > 0 || orphanArts.length > 0) {
    const orphanItems: TimelineItem[] = [
      ...orphanMsgs.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...orphanArts.map((a): TimelineItem => ({ kind: "artifact", data: a })),
    ];
    orphanItems.sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    const napIdx = result.findIndex((item) => item.kind === "nap");
    if (napIdx >= 0) {
      result.splice(napIdx, 0, ...orphanItems);
    } else {
      result.push(...orphanItems);
    }
  }

  return result;
}

/**
 * Whether a completed conversation load may persist the per-channel `last_open`
 * pointer. Only the SLOW path (param-less open, `targetConvId` absent) resolves
 * the channel's latest-created conversation; the FAST path (`?conv=<id>`) loads
 * an explicit, possibly old conversation and must NOT touch the pointer (doing
 * so reintroduces the wrong-conversation flash). See {@link LastOpenEntry}.
 *
 * Pure mirror of the inline Phase B write guard, exported for unit testing the
 * fast-vs-slow decision without rendering the component.
 */
export function shouldPersistPointerForLoad(
  targetConvId: string | null | undefined,
): boolean {
  return !targetConvId;
}

/**
 * Decide whether a `task.created` WS event should refresh this view's
 * per-channel `last_open` pointer, and to which conversation.
 *
 * The `last_open` pointer carries "latest-created conversation for this
 * agent+channel" semantics (see {@link setLastOpenConversation}). A
 * `task.created` event is the client learning of a (possibly newer)
 * conversation in real time, so it is a valid moment to refresh the pointer —
 * but ONLY when the event belongs to exactly this agent + active channel.
 *
 * Returns the conversation id to point at, or `null` to skip the write
 * (different agent, different channel, or the pointer already points there).
 *
 * Pure so the scoping logic is unit-testable in the node-env web test suite
 * (no component render). The caller supplies `serverMessageCount` separately
 * (A1: derived from the locally-cached message count) when it performs the
 * actual `setLastOpenConversation` write.
 */
export function pointerRefreshTargetForTaskCreated(args: {
  /** The TaskApi from the `task.created` event. */
  task: Pick<Task, "agent_id" | "channel" | "conversation_id">;
  /** The agent this view is rendering. */
  agentId: string;
  /** The active channel string (never null — null maps to "default"). */
  activeChannel: string;
  /** The conversation id the pointer currently references, if known. */
  currentPointerConvId: string | null;
}): string | null {
  const { task, agentId, activeChannel, currentPointerConvId } = args;
  // Scope guard: never touch another agent's or channel's pointer. The event's
  // null channel normalizes to "default" to match the UI's channel string
  // (channel-context.tsx). activeChannel is always a non-null string.
  if (task.agent_id !== agentId) return null;
  if ((task.channel ?? "default") !== activeChannel) return null;
  // Already pointing here — nothing to do.
  if (task.conversation_id === currentPointerConvId) return null;
  return task.conversation_id;
}

export function canShowBranchAction(args: {
  conversationType?: string | null;
  supportsBranch: boolean;
  branchingMessageId: string | null;
  hasExistingBranch: boolean;
  messageIsBranchable: boolean;
}): boolean {
  if (args.conversationType === "message_branch") return false;
  if (!args.supportsBranch || args.branchingMessageId !== null) return false;
  if (!args.messageIsBranchable) return false;
  return true;
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
