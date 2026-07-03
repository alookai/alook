import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  communityChannel,
  communityInboxDismissal,
  communityMention,
  communityMessage,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const FOR_YOU_LIMIT_DEFAULT = 50;
// Cap the number of "I participated in this thread" channels we scan per
// user. Without this, a power user who has chimed in on hundreds of threads
// would join + return all of them every time the For You feed is refetched.
// 30 keeps the work bounded while still covering everything a user is
// realistically still tracking.
const THREAD_PARTICIPATION_LIMIT = 30;
const PREVIEW_LEN = 140;

export type ForYouKind = "mention" | "reply" | "thread";

export interface ForYouEventRow {
  eventKey: string;
  kind: ForYouKind;
  serverId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  preview: string;
  createdAt: string;
}

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  lastMessageAt: string;
  lastReadAt: string | null;
}

function buildEventKey(kind: ForYouKind, id: string): string {
  return `${kind}:${id}`;
}

function previewOf(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > PREVIEW_LEN ? `${trimmed.slice(0, PREVIEW_LEN)}…` : trimmed;
}

// ──────────────────────────────────────────────────────────────────────────────
// For You
// ──────────────────────────────────────────────────────────────────────────────

export async function listForYouEvents(
  db: Database,
  userId: string,
  opts: { limit?: number } = {}
): Promise<ForYouEventRow[]> {
  const limit = opts.limit ?? FOR_YOU_LIMIT_DEFAULT;

  // 1. Unread mention rows — kind is "mention" or "reply", carried straight through.
  const mentionRows = await db
    .select({
      kind: communityMention.kind,
      messageId: communityMessage.id,
      channelId: communityMessage.channelId,
      authorId: communityMessage.authorId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
      content: communityMessage.content,
      createdAt: communityMessage.createdAt,
    })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMention.messageId, communityMessage.id))
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0),
        isNotNull(communityMessage.channelId)
      )
    );

  // 3. Threads I participate in that have new messages.
  // Participation = I authored a message in a child channel (parentChannelId
  // IS NOT NULL). We rank by the thread's last activity so a long-time user
  // with hundreds of past threads still sees only the most relevant ones.
  const participatedThreadsRaw = await db
    .selectDistinct({
      channelId: communityMessage.channelId,
      lastMessageAt: communityChannel.lastMessageAt,
    })
    .from(communityMessage)
    .innerJoin(communityChannel, eq(communityMessage.channelId, communityChannel.id))
    .where(
      and(
        eq(communityMessage.authorId, userId),
        isNotNull(communityChannel.parentChannelId),
        isNotNull(communityChannel.lastMessageAt)
      )
    )
    .orderBy(desc(communityChannel.lastMessageAt))
    .limit(THREAD_PARTICIPATION_LIMIT);
  const threadChannelIds = participatedThreadsRaw
    .map((r) => r.channelId)
    .filter((id): id is string => !!id);

  let threadRows: Array<{
    channelId: string;
    serverId: string;
    channelName: string;
    lastMessageAt: string | null;
    lastReadAt: string | null;
  }> = [];
  if (threadChannelIds.length > 0) {
    const raw = await db
      .select({
        channelId: communityChannel.id,
        serverId: communityChannel.serverId,
        channelName: communityChannel.name,
        lastMessageAt: communityChannel.lastMessageAt,
        lastReadAt: communityReadState.lastReadAt,
      })
      .from(communityChannel)
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.channelId, communityChannel.id),
          eq(communityReadState.userId, userId)
        )
      )
      .where(inArray(communityChannel.id, threadChannelIds));
    threadRows = raw.filter(
      (r) =>
        r.lastMessageAt &&
        (!r.lastReadAt || r.lastMessageAt > r.lastReadAt)
    ) as typeof threadRows;
  }

  // Collect all unique channelIds and serverIds for batch hydration
  const allChannelIds = new Set<string>();
  for (const r of mentionRows) if (r.channelId) allChannelIds.add(r.channelId);
  for (const r of threadRows) allChannelIds.add(r.channelId);

  let channelById = new Map<string, { id: string; name: string; serverId: string }>();
  if (allChannelIds.size > 0) {
    const channels = await db
      .select({
        id: communityChannel.id,
        name: communityChannel.name,
        serverId: communityChannel.serverId,
      })
      .from(communityChannel)
      .where(inArray(communityChannel.id, Array.from(allChannelIds)));
    channelById = new Map(channels.map((c) => [c.id, c]));
  }

  const allServerIds = new Set<string>();
  for (const c of channelById.values()) allServerIds.add(c.serverId);

  let serverById = new Map<string, { id: string; name: string }>();
  if (allServerIds.size > 0) {
    const servers = await db
      .select({ id: communityServer.id, name: communityServer.name })
      .from(communityServer)
      .where(inArray(communityServer.id, Array.from(allServerIds)));
    serverById = new Map(servers.map((s) => [s.id, s]));
  }

  // Build event list. mention.kind drives whether this is a "mention" or
  // "reply" event — both come from the mention table now.
  const events: ForYouEventRow[] = [];

  for (const r of mentionRows) {
    const ch = r.channelId ? channelById.get(r.channelId) : null;
    const srv = ch ? serverById.get(ch.serverId) : null;
    if (!ch || !srv) continue;
    const kind: ForYouKind = r.kind === "reply" ? "reply" : "mention";
    events.push({
      eventKey: buildEventKey(kind, r.messageId),
      kind,
      serverId: srv.id,
      serverName: srv.name,
      channelId: ch.id,
      channelName: ch.name,
      messageId: r.messageId,
      authorId: r.authorId,
      authorName: r.authorName ?? r.authorEmail ?? "Unknown",
      authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
      preview: previewOf(r.content ?? ""),
      createdAt: r.createdAt,
    });
  }

  for (const r of threadRows) {
    const srv = serverById.get(r.serverId);
    if (!srv) continue;
    events.push({
      eventKey: buildEventKey("thread", r.channelId),
      kind: "thread",
      serverId: srv.id,
      serverName: srv.name,
      channelId: r.channelId,
      channelName: r.channelName,
      messageId: r.channelId, // thread doesn't anchor to one message; reuse channelId for click target
      authorId: "",
      authorName: "",
      authorAvatar: "",
      preview: "",
      createdAt: r.lastMessageAt!,
    });
  }

  // Filter out dismissed eventKeys
  const allKeys = events.map((e) => e.eventKey);
  if (allKeys.length > 0) {
    const dismissed = await db
      .select({ eventKey: communityInboxDismissal.eventKey })
      .from(communityInboxDismissal)
      .where(
        and(
          eq(communityInboxDismissal.userId, userId),
          inArray(communityInboxDismissal.eventKey, allKeys)
        )
      );
    const dismissedSet = new Set(dismissed.map((r) => r.eventKey));
    return events
      .filter((e) => !dismissedSet.has(e.eventKey))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  return events
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

// ──────────────────────────────────────────────────────────────────────────────
// Unreads
// ──────────────────────────────────────────────────────────────────────────────

export async function listUnreadChannels(
  db: Database,
  userId: string
): Promise<UnreadChannelRow[]> {
  // All top-level channels in servers the user is a member of, plus read state.
  // Filtering by lastMessageAt > lastReadAt happens in JS so we can keep one query.
  const rows = await db
    .select({
      channelId: communityChannel.id,
      channelName: communityChannel.name,
      serverId: communityChannel.serverId,
      serverName: communityServer.name,
      lastMessageAt: communityChannel.lastMessageAt,
      lastReadAt: communityReadState.lastReadAt,
      archived: communityChannel.archived,
    })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .innerJoin(communityServer, eq(communityServer.id, communityChannel.serverId))
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.channelId, communityChannel.id),
        eq(communityReadState.userId, userId)
      )
    )
    .where(
      and(
        eq(communityServerMember.userId, userId),
        isNull(communityChannel.parentChannelId),
        isNotNull(communityChannel.lastMessageAt)
      )
    );

  return rows
    .filter((r) => {
      if (r.archived) return false;
      if (!r.lastMessageAt) return false;
      if (!r.lastReadAt) return true;
      return r.lastMessageAt > r.lastReadAt;
    })
    .map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      serverId: r.serverId,
      serverName: r.serverName,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
    }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Dismissals
// ──────────────────────────────────────────────────────────────────────────────

export async function dismissEvent(
  db: Database,
  userId: string,
  eventKey: string
): Promise<void> {
  await db
    .insert(communityInboxDismissal)
    .values({
      userId,
      eventKey,
      dismissedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [communityInboxDismissal.userId, communityInboxDismissal.eventKey],
    });
}

export async function dismissEvents(
  db: Database,
  userId: string,
  eventKeys: string[]
): Promise<void> {
  if (eventKeys.length === 0) return;
  const now = new Date().toISOString();
  await db
    .insert(communityInboxDismissal)
    .values(eventKeys.map((eventKey) => ({ userId, eventKey, dismissedAt: now })))
    .onConflictDoNothing({
      target: [communityInboxDismissal.userId, communityInboxDismissal.eventKey],
    });
}

export async function listDismissals(db: Database, userId: string) {
  return db
    .select()
    .from(communityInboxDismissal)
    .where(eq(communityInboxDismissal.userId, userId));
}

/**
 * When the user opens a channel, dismiss the thread For You event for it.
 * Mention/reply events are handled by markChannelMentionsRead — they drop
 * out of For You as soon as their mention row is marked read.
 */
export async function dismissForYouForChannel(
  db: Database,
  userId: string,
  channelId: string
): Promise<void> {
  await dismissEvents(db, userId, [`thread:${channelId}`]);
}

/**
 * Batch-friendly builder variant of {@link dismissForYouForChannel}. Returns
 * the INSERT builder directly so it can be composed into `db.batch([...])`.
 * The `ON CONFLICT DO NOTHING` target matches the `uq_inbox_dismissal_user_event`
 * unique index (userId, eventKey).
 */
export function dismissForYouForChannelBuilder(
  db: Database,
  userId: string,
  channelId: string
) {
  return db
    .insert(communityInboxDismissal)
    .values({
      userId,
      eventKey: `thread:${channelId}`,
      dismissedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [communityInboxDismissal.userId, communityInboxDismissal.eventKey],
    });
}
