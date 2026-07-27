/**
 * Seq-based queries powering the `/api/community/agent/*` CLI bridge routes
 * (plans/community-agent-cli-bridge.md §7) plus `toAgentMessages`, the
 * DB-row → wire-`Message` projector every route that returns message bodies
 * uses.
 *
 * Kept in its own module (rather than folded into `message.ts`) because
 * every function here is agent-CLI-specific (seq-ordered, ref-formatted,
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
import {
  formatRef,
  formatSeq,
  DM_SERVER,
  type AgentAttachmentRef,
  type Message,
  type MessageContent,
  type ReplyRef,
  type Seq,
  type ChannelRef,
} from "../../../community-contract";
import { formatHandle } from "../../../lib/discriminator";
import { listVisibleChannelIdsForUser } from "./channel";
import { listParticipatingThreadIds } from "./thread";
import { getMessagesByIdsInScope, type MessageScope } from "./message";
import { isThread, isPost } from "../../../utils/community-roles";

type RawAgentMessage = {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  channelId: string | null;
  dmConversationId: string | null;
  seq: number;
  replyToId: string | null;
};

const AGENT_MESSAGE_COLUMNS = {
  id: communityMessage.id,
  authorId: communityMessage.authorId,
  content: communityMessage.content,
  createdAt: communityMessage.createdAt,
  channelId: communityMessage.channelId,
  dmConversationId: communityMessage.dmConversationId,
  seq: communityMessage.seq,
  replyToId: communityMessage.replyToId,
} as const;

/** One entry per distinct scope (channel or DM) needing a `ChannelRef`. */
type ScopeInfo = { ref: string; isThread: boolean };

/**
 * Batch-resolve a set of channel/DM scopes into their `ChannelRef` path
 * strings — the shared plumbing behind `toAgentMessages` (per-message refs)
 * AND `getInboxSnapshotForAgent` (per-scope `InboxRow.channel` + `thread`
 * flag), so both hydrate refs identically instead of two divergent
 * implementations. Keyed by `channelId` for channel/thread scopes, or
 * `` `dm:${dmConversationId}` `` for DM scopes (channel ids and DM ids are
 * both nanoids from the same id-space, so the `dm:` prefix avoids an
 * accidental collision between the two key spaces).
 */
async function resolveScopeRefs(
  db: Database,
  scopes: Array<{ channelId: string | null; dmConversationId: string | null }>,
  viewerId: string
): Promise<Map<string, ScopeInfo>> {
  const channelIds = [...new Set(scopes.map((s) => s.channelId).filter((x): x is string => !!x))];
  const dmIds = [...new Set(scopes.map((s) => s.dmConversationId).filter((x): x is string => !!x))];

  const [channels, dms] = await Promise.all([
    channelIds.length
      ? db
        .select({
          id: communityChannel.id,
          name: communityChannel.name,
          serverId: communityChannel.serverId,
          parentChannelId: communityChannel.parentChannelId,
          parentMessageId: communityChannel.parentMessageId,
        })
        .from(communityChannel)
        .where(inArray(communityChannel.id, channelIds))
      : Promise.resolve([]),
    dmIds.length
      ? db.select().from(communityDmConversation).where(inArray(communityDmConversation.id, dmIds))
      : Promise.resolve([]),
  ]);

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const dmById = new Map(dms.map((d) => [d.id, d]));

  // DM peer ids → the OTHER party of each dm relative to viewerId — resolved
  // to name+discriminator so the DM ref is a handle (`/.dm/<peer#0042>`), not
  // a raw user id. Batched alongside the author-id fetch below (a separate
  // Promise.all slot, not a second round-trip per dm).
  const dmPeerIds = [
    ...new Set(
      dms
        .map((dm) => (dm.user1Id === viewerId ? dm.user2Id : dm.user1Id))
        .filter((x): x is string => !!x)
    ),
  ];
  const dmPeerUsers = dmPeerIds.length
    ? await db
      .select({ id: user.id, name: user.name, discriminator: user.discriminator })
      .from(user)
      .where(inArray(user.id, dmPeerIds))
    : [];
  const dmPeerById = new Map(dmPeerUsers.map((u) => [u.id, u]));

  const parentChannelIds = [
    ...new Set(channels.map((c) => c.parentChannelId).filter((x): x is string => !!x)),
  ];
  const parentMessageIds = [
    ...new Set(channels.map((c) => c.parentMessageId).filter((x): x is string => !!x)),
  ];
  const serverIds = [...new Set(channels.map((c) => c.serverId))];

  const [parentChannels, servers, parentMessages] = await Promise.all([
    parentChannelIds.length
      ? db
        .select({ id: communityChannel.id, name: communityChannel.name })
        .from(communityChannel)
        .where(inArray(communityChannel.id, parentChannelIds))
      : Promise.resolve([]),
    serverIds.length
      ? db.select({ id: communityServer.id, name: communityServer.name }).from(communityServer).where(inArray(communityServer.id, serverIds))
      : Promise.resolve([]),
    parentMessageIds.length
      ? db.select({ id: communityMessage.id, seq: communityMessage.seq }).from(communityMessage).where(inArray(communityMessage.id, parentMessageIds))
      : Promise.resolve([]),
  ]);

  const parentChannelById = new Map(parentChannels.map((c) => [c.id, c]));
  const serverNameById = new Map(servers.map((s) => [s.id, s.name]));
  const parentSeqById = new Map(parentMessages.map((m) => [m.id, m.seq]));

  const out = new Map<string, ScopeInfo>();
  for (const ch of channels) {
    const serverName = serverNameById.get(ch.serverId) ?? ch.serverId;
    if (ch.parentChannelId && ch.parentMessageId) {
      const parent = parentChannelById.get(ch.parentChannelId);
      const rootSeq = parentSeqById.get(ch.parentMessageId);
      if (parent && rootSeq !== undefined) {
        out.set(ch.id, {
          ref: formatRef({ server: serverName, channel: parent.name, rootSeq: rootSeq }),
          isThread: true,
        });
        continue;
      }
    }
    out.set(ch.id, { ref: formatRef({ server: serverName, channel: ch.name }), isThread: false });
  }
  for (const dm of dms) {
    const peerId = dm.user1Id === viewerId ? dm.user2Id : dm.user1Id;
    const peer = peerId ? dmPeerById.get(peerId) : undefined;
    const peerSegment = peer ? formatHandle(peer.name, peer.discriminator) : peerId || "unknown";
    out.set(`dm:${dm.id}`, { ref: formatRef({ server: DM_SERVER, channel: peerSegment }), isThread: false });
  }
  return out;
}

function scopeRefKey(scope: { channelId: string | null; dmConversationId: string | null }): string {
  return scope.channelId ?? `dm:${scope.dmConversationId}`;
}

/**
 * Batch-hydrate raw message rows into wire `Message`s. `viewerId` is
 * required to resolve DM peer segments — `/.dm/<peer>` is always the OTHER
 * party relative to whichever bot identity is being served (every route
 * that returns messages serves exactly one bot identity per call, so this
 * is unambiguous). No `id` field is ever included on the wire — messages
 * are addressed by channel + seq only (contract doc, `community-contract.ts`).
 */
export async function toAgentMessages(
  db: Database,
  rows: RawAgentMessage[],
  viewerId: string,
  attachmentsByMessageId?: Map<string, AgentAttachmentRef[]>
): Promise<Message[]> {
  if (rows.length === 0) return [];

  const [refs, users, replyByMessageId] = await Promise.all([
    resolveScopeRefs(db, rows, viewerId),
    db
      .select({ id: user.id, name: user.name, discriminator: user.discriminator })
      .from(user)
      .where(inArray(user.id, [...new Set(rows.map((r) => r.authorId))])),
    resolveReplyRefs(db, rows),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const scope = refs.get(scopeRefKey(r));
    const channel = scope?.ref ?? `/unknown/${scopeRefKey(r)}`;
    const author = userById.get(r.authorId);
    const sender = author ? formatHandle(author.name, author.discriminator) : r.authorId;
    // Absent (not empty array) when a message has no attachments — smaller
    // wire payload; documented invariant in the plan.
    const atts = attachmentsByMessageId?.get(r.id);
    const content: MessageContent = { text: r.content };
    if (atts && atts.length > 0) content.attachments = atts;
    const replyTo = r.replyToId ? replyByMessageId.get(r.replyToId) : undefined;
    if (replyTo) content.replyTo = replyTo;
    return {
      seq: formatSeq(r.seq),
      channel,
      sender: `@${sender}`,
      content,
      time: r.createdAt,
      // Id fields emitted alongside the ref-shaped keys so a caller can address
      // by id instead of channel+seq. `channelId` is present only for
      // channel-scoped messages — DM messages carry no channel id (their scope
      // axis is the DM conversation, not a channel).
      id: r.id,
      ...(r.channelId ? { channelId: r.channelId } : {}),
      authorId: r.authorId,
    };
  });
}

/**
 * Resolve each row's `replyToId` into a `ReplyRef` ({ seq, sender }) — the
 * cited-message preview surfaced inside `content.replyTo`. Scope-first: a
 * `replyToId` is only ever resolved WITHIN its own row's channel/DM (via
 * `getMessagesByIdsInScope`), so a cite can never leak a message from another
 * scope. Rows are grouped by scope and one batch query runs per distinct
 * scope. Targets with `seq <= 0` (legacy sentinel rows) are dropped — they'd
 * otherwise emit a bogus `"#0"`. Returns a map keyed by `replyToId`; a
 * `replyToId` absent from the map (deleted / out-of-scope / seq 0) means the
 * caller omits `replyTo` entirely.
 */
async function resolveReplyRefs(
  db: Database,
  rows: RawAgentMessage[]
): Promise<Map<string, ReplyRef>> {
  // Group each row's replyToId by the row's OWN scope (channel or DM).
  const idsByScope = new Map<string, { scope: MessageScope; ids: Set<string> }>();
  for (const r of rows) {
    if (!r.replyToId) continue;
    const scope: MessageScope | null = r.channelId
      ? { channelId: r.channelId }
      : r.dmConversationId
        ? { dmConversationId: r.dmConversationId }
        : null;
    if (!scope) continue;
    const key = scopeRefKey(r);
    let bucket = idsByScope.get(key);
    if (!bucket) {
      bucket = { scope, ids: new Set<string>() };
      idsByScope.set(key, bucket);
    }
    bucket.ids.add(r.replyToId);
  }
  if (idsByScope.size === 0) return new Map();

  const perScope = await Promise.all(
    [...idsByScope.values()].map((b) => getMessagesByIdsInScope(db, [...b.ids], b.scope))
  );

  const out = new Map<string, ReplyRef>();
  for (const targets of perScope) {
    for (const t of targets) {
      if (t.seq <= 0) continue;
      out.set(t.id, {
        seq: formatSeq(t.seq),
        sender: `@${formatHandle(t.authorName, t.discriminator)}`,
      });
    }
  }
  return out;
}

/**
 * Strict single-scope ref resolver for `UnreadNotice.channel`
 * (`buildUnreadWakeCommand`, minimal-wake-queue-unread-notice plan §4). Unlike
 * `resolveScopeRefs` (used for message/inbox hydration, where an `/unknown/…`
 * fallback is tolerable UI degradation), a wake command's notice channel must
 * NEVER be a placeholder — a missing channel, missing DM, missing parent
 * channel, or missing parent message for a thread all resolve to `null` so
 * the caller treats it as `notice_channel_unresolvable` (ack/skip) rather
 * than waking an agent with a bogus ref it can't `inboxPull` against.
 */
export async function resolveUnreadNoticeChannel(
  db: Database,
  scope: { channelId?: string; dmConversationId?: string },
  botUserId: string
): Promise<ChannelRef | null> {
  if (scope.channelId) {
    const rows = await db
      .select({
        id: communityChannel.id,
        name: communityChannel.name,
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
          .select({ name: communityChannel.name, serverId: communityChannel.serverId })
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
      return formatRef({ server: serverName, channel: parent.name, rootSeq: root.seq });
    }

    const serverName = await getServerName(db, ch.serverId);
    if (!serverName) return null;
    return formatRef({ server: serverName, channel: ch.name });
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
      .select({ name: user.name, discriminator: user.discriminator })
      .from(user)
      .where(eq(user.id, peerId))
      .limit(1);
    const peer = peerRows[0];
    // A wake command's notice channel must NEVER be a placeholder (see this
    // function's doc comment) — a peer that no longer resolves to a
    // name+discriminator is `notice_channel_unresolvable`, same as any other
    // missing-scope case, not a bare-peerId ref the agent can't act on.
    if (!peer) return null;
    return formatRef({ server: DM_SERVER, channel: formatHandle(peer.name, peer.discriminator) });
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

/** Single-row convenience wrapper around `toAgentMessages`. */
export async function toAgentMessage(
  db: Database,
  row: RawAgentMessage,
  viewerId: string,
  attachments?: AgentAttachmentRef[]
): Promise<Message> {
  const map = attachments && attachments.length > 0 ? new Map([[row.id, attachments]]) : undefined;
  const [msg] = await toAgentMessages(db, [row], viewerId, map);
  return msg!;
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
 * Cross-channel unread fill for `inboxPull`, grouped by channel/DM (not
 * global seq order — `seq` is a per-scope counter, comparing raw values
 * across scopes is meaningless, see plan §7 v4). Always drains one channel's
 * unread completely (in seq order) before starting the next. Excludes the
 * bot's own authored messages. Never mutates read state.
 *
 * Visibility rule: same as the human unread path (`listUnreadChannels`) —
 * (1) channel messages restricted to `listVisibleChannelIdsForUser(botUserId)`
 * (respects private-category rosters and private-forum-post narrowness), and
 * (2) thread / post channels additionally require a
 * `community_thread_participant` row for the bot. Both dimensions are folded
 * into ONE `inArray` predicate up front so `.limit(max)` operates on
 * already-visible rows — post-filtering after `limit` (the earlier shape)
 * could silently collapse a page to `[]` and break `hasMore`.
 */
export async function listUnreadMessagesForAgent(
  db: Database,
  botUserId: string,
  opts: { max: number }
): Promise<RawAgentMessage[]> {
  const allowedChannelIds = await listAgentAllowedChannelIds(db, botUserId);

  const rows = await db
    .select({
      ...AGENT_MESSAGE_COLUMNS,
      lastReadSeq: sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`,
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
    .orderBy(asc(communityMessage.channelId), asc(communityMessage.dmConversationId), asc(communityMessage.seq))
    .limit(opts.max);

  return rows.map(({ lastReadSeq: _lastReadSeq, ...rest }) => rest);
}

export type InboxSnapshotRow = {
  channelId: string | null;
  dmConversationId: string | null;
  pendingCount: number;
  firstPendingSeq: number;
  latestSeq: number;
  latestSender: string;
  hasMention: boolean;
};

/**
 * Per-channel/DM unread summary for `inboxSnapshot` — non-consuming, no read-
 * state mutation. One row per scope with pending unread.
 *
 * Visibility rule mirrors `listUnreadMessagesForAgent`: (1) channel scopes
 * restricted to `listVisibleChannelIdsForUser(botUserId)`, and (2) scopes of
 * type `thread` or `post` additionally require a
 * `community_thread_participant` row for the bot (post-filter). Because the
 * outer `WHERE` is `inArray(channelId, visibleChannelIds)` and non-participated
 * thread rows are dropped in the post-filter, `hasMention` (a correlated
 * sub-select keyed on the surviving row's `channel_id`) can never inherit a
 * mention from an invisible or non-participated thread — do NOT try to
 * sub-select mentions independently or the leak reopens on this axis.
 */
export async function getInboxSnapshotForAgent(db: Database, botUserId: string): Promise<InboxSnapshotRow[]> {
  const allowedChannelIds = await listAgentAllowedChannelIds(db, botUserId);

  const rows = await db
    .select({
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      pendingCount: sql<number>`COUNT(*)`,
      firstPendingSeq: sql<number>`MIN(${communityMessage.seq})`,
      latestSeq: sql<number>`MAX(${communityMessage.seq})`,
      latestSenderId: sql<string>`(SELECT author_id FROM community_message m2
        WHERE (m2.channel_id = ${communityMessage.channelId} OR m2.dm_conversation_id = ${communityMessage.dmConversationId})
        ORDER BY m2.seq DESC LIMIT 1)`,
      mentionCount: sql<number>`(SELECT COUNT(*) FROM community_mention cm
        INNER JOIN community_message m3 ON m3.id = cm.message_id
        WHERE cm.user_id = ${botUserId} AND cm.kind = 'mention'
          AND (m3.channel_id = ${communityMessage.channelId} OR m3.dm_conversation_id = ${communityMessage.dmConversationId})
          AND m3.seq > COALESCE(${communityReadState.lastReadSeq}, 0))`,
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
    .groupBy(communityMessage.channelId, communityMessage.dmConversationId);

  if (rows.length === 0) return [];

  const filtered = rows;

  const senderIds = [...new Set(filtered.map((r) => r.latestSenderId).filter(Boolean))];
  const users = senderIds.length
    ? await db
      .select({ id: user.id, name: user.name, discriminator: user.discriminator })
      .from(user)
      .where(inArray(user.id, senderIds))
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return filtered.map((r) => {
    const sender = userById.get(r.latestSenderId);
    return {
      channelId: r.channelId,
      dmConversationId: r.dmConversationId,
      pendingCount: r.pendingCount,
      firstPendingSeq: r.firstPendingSeq,
      latestSeq: r.latestSeq,
      latestSender: `@${sender ? formatHandle(sender.name, sender.discriminator) : r.latestSenderId}`,
      hasMention: r.mentionCount > 0,
    };
  });
}

/**
 * Hydrate `getInboxSnapshotForAgent`'s DB-shaped rows into wire `InboxRow`s
 * (`channel: ChannelRef`, `flags`) for the `inboxSnapshot` route. Separate
 * from the DB query itself so the aggregation and the ref/flag projection
 * (which needs `resolveScopeRefs`' extra round trip) stay independently
 * testable, mirroring `toAgentMessage(s)`'s split for message rows.
 */
export async function toInboxRows(
  db: Database,
  rows: InboxSnapshotRow[],
  viewerId: string
): Promise<Array<{
  channel: string;
  pendingCount: number;
  firstPendingSeq: number;
  latestSeq: number;
  latestSender: string;
  flags: Array<"dm" | "thread" | "mention">;
}>> {
  if (rows.length === 0) return [];
  const refs = await resolveScopeRefs(db, rows, viewerId);
  return rows.map((r) => {
    const scope = refs.get(scopeRefKey(r));
    const flags: Array<"dm" | "thread" | "mention"> = [];
    if (r.dmConversationId) flags.push("dm");
    if (scope?.isThread) flags.push("thread");
    if (r.hasMention) flags.push("mention");
    return {
      channel: scope?.ref ?? `/unknown/${scopeRefKey(r)}`,
      pendingCount: r.pendingCount,
      firstPendingSeq: r.firstPendingSeq,
      latestSeq: r.latestSeq,
      latestSender: r.latestSender,
      flags,
    };
  });
}

/**
 * The single most-recent unread message id for a bot, across ALL its scopes
 * (channels + DMs combined) — feeds `dispatchOneUnreadWake`'s `{ messageId,
 * botUserId }` input for a daemon-initiated wake resync (as opposed to
 * `getInboxSnapshotForAgent`'s per-scope aggregation, which has no single
 * message id to hand back). "Most recent" is by `createdAt`, since `seq` is a
 * per-scope counter and isn't comparable across scopes (see
 * `listUnreadMessagesForAgent`'s doc comment).
 *
 * Visibility rule identical to `listUnreadMessagesForAgent`: the bot must be
 * able to see the channel (`listVisibleChannelIdsForUser`) AND, for thread /
 * post scopes, hold a `community_thread_participant` row. Both
 * dimensions are folded into the SQL WHERE via `listAgentAllowedChannelIds`
 * so `LIMIT 1` returns the newest allowed row directly — an earlier shape
 * used a bounded post-filter window that could return `null` when older
 * allowed unread existed outside the top-N-by-createdAt slice.
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
