/**
 * Seq-based queries powering the agent wake pipeline and seq-anchored reads.
 *
 * Kept in its own module (rather than folded into `message.ts`) because
 * every function here is agent-CLI-specific (seq-ordered,
 * self-message-excluding) — a different shape from `message.ts`'s
 * `createdAt`-ordered, DB-shaped human-UI queries.
 */
import { eq, and, or, inArray, gt, lt, ne, asc, desc, sql, isNotNull } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityDmConversation,
  communityServer,
  communityReadState,
  communityMessageSeq,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import type { Seq } from "../../../community-contract";
import { listVisibleChannelIdsForUser } from "./channel";
import { listParticipatingThreadIds } from "./thread";
import { isThread, isPost } from "../../../utils/community-roles";

type RawAgentMessage = {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  channelId: string | null;
  dmConversationId: string | null;
  seq: number;
};

const AGENT_MESSAGE_COLUMNS = {
  id: communityMessage.id,
  authorId: communityMessage.authorId,
  content: communityMessage.content,
  createdAt: communityMessage.createdAt,
  channelId: communityMessage.channelId,
  dmConversationId: communityMessage.dmConversationId,
  seq: communityMessage.seq,
} as const;

/**
 * Strict single-scope resolver for a wake notice's scope
 * (`buildUnreadWakeCommand`). A wake command's target scope must NEVER be a
 * placeholder — a missing channel, missing DM, missing parent channel, or
 * missing parent message for a thread all resolve to `null` so the caller
 * treats it as `notice_channel_unresolvable` (ack/skip) rather than waking an
 * agent against a scope it can't reach. On success it returns the stable id of
 * the resolved scope (the channel id for a channel/thread scope, the DM
 * conversation id for a DM scope) — the bot addresses everything by id.
 */
export async function resolveUnreadNoticeChannel(
  db: Database,
  scope: { channelId?: string; dmConversationId?: string },
  botUserId: string
): Promise<string | null> {
  if (scope.channelId) {
    const rows = await db
      .select({
        id: communityChannel.id,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
        parentMessageId: communityChannel.parentMessageId,
      })
      .from(communityChannel)
      .where(eq(communityChannel.id, scope.channelId))
      .limit(1);
    const ch = rows[0];
    if (!ch) return null;

    if (ch.parentChannelId && ch.parentMessageId) {
      const [parentRows, rootRows] = await Promise.all([
        db
          .select({ serverId: communityChannel.serverId })
          .from(communityChannel)
          .where(eq(communityChannel.id, ch.parentChannelId))
          .limit(1),
        db
          .select({ seq: communityMessage.seq })
          .from(communityMessage)
          .where(eq(communityMessage.id, ch.parentMessageId))
          .limit(1),
      ]);
      const parent = parentRows[0];
      const root = rootRows[0];
      if (!parent || !root) return null;
      const serverName = await getServerName(db, parent.serverId);
      if (!serverName) return null;
      return ch.id;
    }

    const serverName = await getServerName(db, ch.serverId);
    if (!serverName) return null;
    return ch.id;
  }

  if (scope.dmConversationId) {
    const rows = await db
      .select()
      .from(communityDmConversation)
      .where(eq(communityDmConversation.id, scope.dmConversationId))
      .limit(1);
    const dm = rows[0];
    if (!dm) return null;
    const peerId = dm.user1Id === botUserId ? dm.user2Id : dm.user1Id;
    if (!peerId) return null;
    const peerRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, peerId))
      .limit(1);
    // A wake command's target scope must NEVER be a placeholder (see this
    // function's doc comment) — a peer that no longer resolves is
    // `notice_channel_unresolvable`, same as any other missing-scope case.
    if (!peerRows[0]) return null;
    return dm.id;
  }

  return null;
}

async function getServerName(db: Database, serverId: string): Promise<string | null> {
  const rows = await db
    .select({ name: communityServer.name })
    .from(communityServer)
    .where(eq(communityServer.id, serverId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/**
 * The counter's `next_seq` holds the most recently issued value (NOT "the
 * next value to hand out" despite the column name) — 0 if no message has
 * ever been sent in this scope. Used by the `send` route's alignment gate.
 */
export async function getLatestSeqForScope(db: Database, scopeKey: string): Promise<Seq> {
  const rows = await db
    .select({ nextSeq: communityMessageSeq.nextSeq })
    .from(communityMessageSeq)
    .where(eq(communityMessageSeq.scopeKey, scopeKey));
  return rows[0]?.nextSeq ?? 0;
}

/**
 * Effective allowed channel-id set for a bot: visible channels MINUS
 * thread/post channels the bot isn't a participant of. Pushes the
 * thread-participation narrowing into a pre-computed set so it can join the
 * message SQL as a single `inArray` predicate — the old shape did the
 * narrowing as a JS post-filter AFTER `.limit(max)`, which silently
 * collapsed a page of non-participating rows to `[]` (breaking `hasMore` in
 * `inboxPull`) and could return `null` from `getLatestUnreadMessageForAgent`
 * when older participating unread existed outside the top-N-by-createdAt
 * candidate window.
 */
async function listAgentAllowedChannelIds(db: Database, botUserId: string): Promise<string[]> {
  const visibleChannelIds = await listVisibleChannelIdsForUser(db, botUserId);
  if (visibleChannelIds.length === 0) return [];
  const typeRows = await db
    .select({ id: communityChannel.id, type: communityChannel.type })
    .from(communityChannel)
    .where(inArray(communityChannel.id, visibleChannelIds));
  const narrowIds = typeRows
    .filter((r) => isThread(r.type) || isPost(r.type))
    .map((r) => r.id);
  const participating =
    narrowIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, narrowIds, botUserId))
      : new Set<string>();
  const narrowSet = new Set(narrowIds);
  return visibleChannelIds.filter((id) => !narrowSet.has(id) || participating.has(id));
}

/**
 * The single most-recent unread message id for a bot, across ALL its scopes
 * (channels + DMs combined) — feeds `dispatchOneUnreadWake`'s `{ messageId,
 * botUserId }` input for a daemon-initiated wake resync. "Most recent" is by
 * `createdAt`, since `seq` is a per-scope counter and isn't comparable across
 * scopes.
 *
 * Visibility rule: the bot must be able to see the channel
 * (`listVisibleChannelIdsForUser`) AND, for thread / post scopes, hold a
 * `community_thread_participant` row. Both dimensions are folded into the SQL
 * WHERE via `listAgentAllowedChannelIds` so `LIMIT 1` returns the newest
 * allowed row directly — an earlier shape used a bounded post-filter window
 * that could return `null` when older allowed unread existed outside the
 * top-N-by-createdAt slice.
 */
export async function getLatestUnreadMessageForAgent(
  db: Database,
  botUserId: string
): Promise<{ messageId: string } | null> {
  const allowedChannelIds = await listAgentAllowedChannelIds(db, botUserId);

  const rows = await db
    .select({
      id: communityMessage.id,
    })
    .from(communityMessage)
    .leftJoin(communityDmConversation, eq(communityDmConversation.id, communityMessage.dmConversationId))
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.userId, botUserId),
        or(
          eq(communityReadState.channelId, communityMessage.channelId),
          eq(communityReadState.dmConversationId, communityMessage.dmConversationId)
        )
      )
    )
    .where(
      and(
        ne(communityMessage.authorId, botUserId),
        sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
        or(
          and(
            isNotNull(communityMessage.channelId),
            allowedChannelIds.length > 0
              ? inArray(communityMessage.channelId, allowedChannelIds)
              : sql`1 = 0`
          ),
          and(
            isNotNull(communityMessage.dmConversationId),
            or(eq(communityDmConversation.user1Id, botUserId), eq(communityDmConversation.user2Id, botUserId))
          )
        )
      )
    )
    .orderBy(desc(communityMessage.createdAt))
    .limit(1);

  const r = rows[0];
  return r ? { messageId: r.id } : null;
}

/**
 * Seq-anchored pagination for `read` — the existing `listMessages` orders by
 * `createdAt` and has no `around` support, so this is a dedicated query.
 * Exactly one of `before`/`after`/`around` should be set (validated at the
 * Zod layer); `around` centers the window and ignores the other two.
 */
export async function listMessagesBySeq(
  db: Database,
  target: { channelId?: string; dmConversationId?: string },
  opts: { before?: Seq; after?: Seq; around?: Seq; limit?: number }
): Promise<{ items: RawAgentMessage[]; hasMore: boolean; latestSeq?: Seq }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const scopeCond = target.channelId
    ? eq(communityMessage.channelId, target.channelId)
    : eq(communityMessage.dmConversationId, target.dmConversationId!);
  const excludeSentinel = gt(communityMessage.seq, 0);

  let items: RawAgentMessage[];
  if (opts.around !== undefined) {
    const at = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel, eq(communityMessage.seq, opts.around)));
    const includesAnchor = at.length > 0;
    const beforeLimit = Math.floor((limit - (includesAnchor ? 1 : 0)) / 2);
    const afterLimit = limit - (includesAnchor ? 1 : 0) - beforeLimit;
    const before = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel, lt(communityMessage.seq, opts.around)))
      .orderBy(desc(communityMessage.seq))
      .limit(beforeLimit + 1);
    const after = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel, gt(communityMessage.seq, opts.around)))
      .orderBy(asc(communityMessage.seq))
      .limit(afterLimit + 1);
    const hasMoreBefore = before.length > beforeLimit;
    const hasMoreAfter = after.length > afterLimit;
    items = [...before.slice(0, beforeLimit).reverse(), ...at, ...after.slice(0, afterLimit)];
    return {
      items,
      hasMore: hasMoreBefore || hasMoreAfter,
      latestSeq: items.length > 0 ? items[items.length - 1]!.seq : undefined,
    };
  } else if (opts.after !== undefined) {
    items = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel, gt(communityMessage.seq, opts.after)))
      .orderBy(asc(communityMessage.seq))
      .limit(limit + 1);
  } else if (opts.before !== undefined) {
    items = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel, lt(communityMessage.seq, opts.before)))
      .orderBy(desc(communityMessage.seq))
      .limit(limit + 1);
    items.reverse();
  } else {
    items = await db
      .select(AGENT_MESSAGE_COLUMNS)
      .from(communityMessage)
      .where(and(scopeCond, excludeSentinel))
      .orderBy(desc(communityMessage.seq))
      .limit(limit + 1);
    items.reverse();
  }

  const hasMore = items.length > limit;
  if (hasMore) {
    // Trim the extra probe row from whichever end we over-fetched from.
    if (opts.after !== undefined) items = items.slice(0, limit);
    else items = items.slice(items.length - limit);
  }

  // `Page.latestSeq` is documented as "seq of the newest item in THIS page,
  // for advancing a cursor" (`community-contract.ts`) — not the scope's
  // global latest (that's `getLatestSeqForScope`, a different call for a
  // different purpose: the `send` route's alignment gate). `items` is always
  // seq-ascending by construction above (all four branches sort/reverse to
  // ascending before returning), so the newest item is the last one.
  const latestSeq = items.length > 0 ? items[items.length - 1]!.seq : undefined;

  return { items, hasMore, latestSeq };
}
