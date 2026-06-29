/**
 * Agent inbox projection.
 *
 * Turns a flat list of pending (unconsumed) messages into the per-target
 * "inbox notice" snapshot the agent is shown — e.g.
 *   `#all  pending: 2 · first msg=… · latest @gustavo-ye …`
 *
 * Messages are bucketed by their resolved `target` (channel / DM / thread),
 * each bucket summarized (count, first, latest, sender, flags), and the
 * buckets sorted by most-recent activity. The summary is metadata only — it
 * never carries message bodies; the agent pulls those with `alook message check`.
 *
 * Generic agent-backend abstraction (host-neutral).
 */

export interface InboxMessage {
  seq?: number;
  message_id?: string;
  id?: string;
  channel_id?: string;
  parent_channel_id?: string;
  channel_type?: "channel" | "dm" | "thread";
  channel_name?: string;
  parent_channel_type?: "channel" | "dm";
  parent_channel_name?: string;
  sender_name?: string;
  senderName?: string;
  sender_type?: string;
  senderType?: string;
  task_number?: number;
  task_status?: string;
  mention?: boolean;
  mentioned?: boolean;
}

export type InboxFlag = "thread" | "dm" | "task" | "mention";

export interface InboxBucketSnapshot {
  target: string;
  channelId?: string;
  channelType?: string;
  pendingCount: number;
  firstPendingMsgId?: string;
  firstPendingSeq?: number;
  latestMsgId?: string;
  latestSeq?: number;
  latestSenderName?: string;
  latestSenderType?: "human" | "agent" | "system";
  flags: InboxFlag[];
}

/** Bucket all pending messages by target and project each into a summary. */
export function projectAgentInboxSnapshot(messages: InboxMessage[]): InboxBucketSnapshot[] {
  const buckets = new Map<string, InboxMessage[]>();
  for (const message of messages) {
    const target = formatInboxMessageTarget(message);
    if (!target) continue;
    const bucket = buckets.get(target) ?? [];
    bucket.push(message);
    buckets.set(target, bucket);
  }
  return [...buckets.entries()]
    .map(([target, bucket]) => projectBucket(target, bucket))
    .sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0) || a.target.localeCompare(b.target));
}

function projectBucket(target: string, messages: InboxMessage[]): InboxBucketSnapshot {
  const sorted = [...messages].sort(compareInboxMessages);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const flags = new Set<InboxFlag>();
  for (const message of messages) {
    if (message.channel_type === "thread") flags.add("thread");
    if (message.channel_type === "dm") flags.add("dm");
    if (message.task_number || message.task_status) flags.add("task");
    if (message.mention === true || message.mentioned === true) flags.add("mention");
  }
  return stripUndefined({
    target,
    channelId: latest.channel_id ?? latest.parent_channel_id,
    channelType: latest.channel_type,
    pendingCount: messages.length,
    firstPendingMsgId: messageId(first),
    firstPendingSeq: messageSeq(first),
    latestMsgId: messageId(latest),
    latestSeq: messageSeq(latest),
    latestSenderName: latest.sender_name ?? latest.senderName,
    latestSenderType: normalizeSenderType(latest.sender_type ?? latest.senderType),
    flags: [...flags].sort(),
  });
}

function compareInboxMessages(a: InboxMessage, b: InboxMessage): number {
  return (messageSeq(a) ?? 0) - (messageSeq(b) ?? 0) || (messageId(a) ?? "").localeCompare(messageId(b) ?? "");
}

/** Build the canonical target string for a message (channel / dm / thread). */
export function formatInboxMessageTarget(message: InboxMessage): string | null {
  if (message.channel_type === "thread" && message.parent_channel_name && message.channel_name) {
    const raw = String(message.channel_name);
    const shortId = shortMessageId(raw.startsWith("thread-") ? raw.slice("thread-".length) : raw);
    if (message.parent_channel_type === "dm") return `dm:@${message.parent_channel_name}:${shortId}`;
    return `#${message.parent_channel_name}:${shortId}`;
  }
  if (message.channel_type === "dm" && message.channel_name) return `dm:@${message.channel_name}`;
  if (message.channel_name) return `#${message.channel_name}`;
  return null;
}

function messageId(message: InboxMessage | undefined): string | undefined {
  if (!message) return undefined;
  return nonEmptyString(message.message_id) ?? nonEmptyString(message.id);
}

function messageSeq(message: InboxMessage | undefined): number | undefined {
  if (!message || typeof message.seq !== "number" || !Number.isFinite(message.seq) || message.seq <= 0) {
    return undefined;
  }
  return Math.floor(message.seq);
}

function shortMessageId(value: string): string {
  return value.slice(0, 8);
}

function normalizeSenderType(value: string | undefined): "human" | "agent" | "system" | undefined {
  return value === "human" || value === "agent" || value === "system" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
