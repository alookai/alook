
import { eq, and, inArray, gt, lt, ne, asc, desc, sql } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityChannelMember,
  communityServerMember,
  communityServer,
  communityReadState,
  communityMessageSeq,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import {
  formatCanonicalRef,
  formatSeq,
  type AgentAttachmentRef,
  type Message,
  type MessageContent,
  type ReplyRef,
  type Seq,
  type ChannelRef,
} from "../../../community-cli-contract";
import {
  DECISION_CARD_MESSAGE_TYPE,
  extractDecisionCardFromEmbeds,
  parseRawEmbedsArray,
  toDecisionCardAgentPayload,
} from "../../../community-decision-card";
import { formatHandle } from "../../../lib/discriminator";
import { listVisibleChannelIdsForUser } from "./channel";
import { listDmChannelIdsForUser } from "./dm";
import { listParticipatingThreadIds } from "./thread";
import { getMessagesByIdsInScope, type MessageScope } from "./message";
import { reachIsParticipantSet, type StoredChannelType } from "../../../utils/community-roles";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { jsonTextSet } from "../_json-set";
import { withD1Retry } from "../../resilience";
import {
  hasAttentionSql,
  hasDirectMentionSql,
  loadUserNotificationSettingLookup,
  resolveEffectiveNotificationLevel,
} from "./notification-eligibility";

type RawAgentMessage = {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  channelId: string;
  seq: number;
  replyToId: string | null;
  type?: string | null;
  embeds?: unknown;
};

const AGENT_MESSAGE_COLUMNS = {
  id: communityMessage.id,
  authorId: communityMessage.authorId,
  content: communityMessage.content,
  createdAt: communityMessage.createdAt,
  channelId: communityMessage.channelId,
  seq: communityMessage.seq,
  replyToId: communityMessage.replyToId,
  type: communityMessage.type,
  embeds: communityMessage.embeds,
} as const;

type ScopeInfo = {
  ref: string;
  isThread: boolean;
  isDm: boolean;
  isForum: boolean;
};

/**
 * Batch-resolve a set of channel ids into their `ChannelRef` path strings —
 * the shared plumbing behind `toAgentMessages` (per-message refs) AND
 * `getInboxSnapshotForAgent` (per-scope `InboxRow.channel` + `thread`/`dm`
 * flags), so both hydrate refs identically. Keyed by `channelId`. A DM
 * (type=dm, server_id NULL) resolves to `/.dm/<peer#0042>` using the OTHER
 * relation='access' member relative to `viewerId`.
 */
async function resolveScopeRefs(
  db: Database,
  scopes: Array<{ channelId: string }>,
  viewerId: string
): Promise<Map<string, ScopeInfo>> {
  const channelIds = [...new Set(scopes.map((s) => s.channelId))];
  if (channelIds.length === 0) return new Map();

  // Chunk the `inArray` for D1's 100-param limit — a page of up to 201 agent
  // messages can span >100 distinct channels; no order/limit → concat.
  const channels = (
    await Promise.all(
      chunk(channelIds, D1_MAX_IN_PARAMS).map((ids) =>
        withD1Retry(() => db
          .select({
            id: communityChannel.id,
            name: communityChannel.name,
            type: communityChannel.type,
            serverId: communityChannel.serverId,
            parentChannelId: communityChannel.parentChannelId,
            parentMessageId: communityChannel.parentMessageId,
          })
          .from(communityChannel)
          .where(inArray(communityChannel.id, ids)), { route: "community/agent-inbox:scope-channels" })
      )
    )
  ).flat();

  const dmChannelIds = channels.filter((c) => c.type === "dm").map((c) => c.id);
  // DM peers: the OTHER access member per DM channel, resolved to a handle.
  const dmMemberRows = dmChannelIds.length
    ? (
        await Promise.all(
          chunk(dmChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
            withD1Retry(() => db
              .select({
                channelId: communityChannelMember.channelId,
                userId: communityChannelMember.userId,
              })
              .from(communityChannelMember)
              .where(
                and(
                  inArray(communityChannelMember.channelId, ids),
                  eq(communityChannelMember.relation, "access"),
                  ne(communityChannelMember.userId, viewerId)
                )
              ), { route: "community/agent-inbox:dm-members" })
          )
        )
      ).flat()
    : [];
  const peerByDmChannel = new Map<string, string>();
  for (const m of dmMemberRows) {
    if (!peerByDmChannel.has(m.channelId)) peerByDmChannel.set(m.channelId, m.userId);
  }
  const dmPeerIds = [...new Set([...peerByDmChannel.values()])];
  const dmPeerUsers = dmPeerIds.length
    ? (
        await Promise.all(
          chunk(dmPeerIds, D1_MAX_IN_PARAMS).map((ids) =>
            withD1Retry(() => db
              .select({ id: user.id, name: user.name, discriminator: user.discriminator })
              .from(user)
              .where(inArray(user.id, ids)), { route: "community/agent-inbox:dm-peers" })
          )
        )
      ).flat()
    : [];
  const dmPeerById = new Map(dmPeerUsers.map((u) => [u.id, u]));

  const parentChannelIds = [
    ...new Set(channels.map((c) => c.parentChannelId).filter((x): x is string => !!x)),
  ];
  const parentMessageIds = [
    ...new Set(channels.map((c) => c.parentMessageId).filter((x): x is string => !!x)),
  ];
  const serverIds = [...new Set(channels.map((c) => c.serverId).filter((x): x is string => !!x))];

  // Each of these `inArray`s is fed by an unbounded channel set (a page of up to
  // 201 agent messages), so chunk for D1's 100-param limit; no order/limit → concat.
  const chunkedIn = <T>(
    ids: string[],
    run: (batch: string[]) => Promise<T[]>
  ): Promise<T[]> =>
    ids.length
      ? Promise.all(
          chunk(ids, D1_MAX_IN_PARAMS).map((batch) =>
            withD1Retry(() => run(batch), { route: "community/agent-inbox:scope-context" })
          )
        ).then((r) => r.flat())
      : Promise.resolve([]);

  const [parentChannels, servers, parentMessages] = await Promise.all([
    chunkedIn(parentChannelIds, (ids) =>
      db
        .select({ id: communityChannel.id, name: communityChannel.name })
        .from(communityChannel)
        .where(inArray(communityChannel.id, ids))
    ),
    chunkedIn(serverIds, (ids) =>
      db.select({ id: communityServer.id, name: communityServer.name, discriminator: communityServer.discriminator }).from(communityServer).where(inArray(communityServer.id, ids))
    ),
    chunkedIn(parentMessageIds, (ids) =>
      db.select({ id: communityMessage.id, seq: communityMessage.seq }).from(communityMessage).where(inArray(communityMessage.id, ids))
    ),
  ]);

  const parentChannelById = new Map(parentChannels.map((c) => [c.id, c]));
  const serverHandleById = new Map(servers.map((s) => [s.id, formatHandle(s.name, s.discriminator)]));
  const parentSeqById = new Map(parentMessages.map((m) => [m.id, m.seq]));

  const out = new Map<string, ScopeInfo>();
  for (const ch of channels) {

    const storedType = (ch.type ?? "text") as StoredChannelType;
    const isDm = storedType === "dm";
    let peerSegment: string | undefined;
    if (isDm) {
      const peerId = peerByDmChannel.get(ch.id);
      const peer = peerId ? dmPeerById.get(peerId) : undefined;
      if (!peer) throw new Error("DM peer identity unavailable");
      peerSegment = formatHandle(peer.name, peer.discriminator);
    }
    const serverHandle = ch.serverId ? serverHandleById.get(ch.serverId) : undefined;
    const parent = ch.parentChannelId ? parentChannelById.get(ch.parentChannelId) : undefined;
    const rootSeq = ch.parentMessageId ? parentSeqById.get(ch.parentMessageId) : undefined;
    // A thread is a `parent`-anchored child carrying a `parentMessageId` (→
    // root seq). Only emit "thread" once that root seq actually resolved —
    // otherwise fall through to the raw stored type (degrades to the
    // "unresolvable" sentinel below via formatCanonicalRef returning null).
    const emitType: StoredChannelType =
      ch.parentChannelId && ch.parentMessageId && parent && rootSeq !== undefined
        ? "thread"
        : storedType;
    const ref = formatCanonicalRef({
      type: emitType,
      serverHandle,
      name: ch.name,
      parentName: parent?.name,
      rootSeq,
      peerSegment,
    });
    // Scope identity is required for delivery. A fabricated sentinel would look
    // like a route to downstream tokenizers while leaking an internal id, and a
    // skipped row would violate never-drop. Fail the whole batch so its cursor
    // is not advanced and the owed message can be retried after data repair.
    if (ref === null) throw new Error("Channel identity unavailable");
    out.set(ch.id, {
      ref,
      isThread: emitType === "thread",
      isDm,
      isForum: storedType === "forum",
    });
  }
  return out;
}

function scopeRefKey(scope: { channelId: string }): string {
  return scope.channelId;
}

/**
 * Batch-hydrate raw message rows into wire `Message`s. `viewerId` is
 * required to resolve DM peer segments — `/.dm/<peer>` is always the OTHER
 * party relative to whichever bot identity is being served (every route
 * that returns messages serves exactly one bot identity per call, so this
 * is unambiguous). No `id` field is ever included on the wire — messages
 * are addressed by channel + seq only (contract doc, `community-cli-contract.ts`).
 */
export async function toAgentMessages(
  db: Database,
  rows: RawAgentMessage[],
  viewerId: string,
  attachmentsByMessageId?: Map<string, AgentAttachmentRef[]>
): Promise<Message[]> {
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const [refs, users, replyByMessageId] = await Promise.all([
    resolveScopeRefs(db, rows, viewerId),
    // Chunk the `inArray` for D1's 100-param limit — a page of up to 201 agent
    // messages can carry >100 distinct authors; no order/limit → concat.
    Promise.all(
      chunk(authorIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({ id: user.id, name: user.name, discriminator: user.discriminator })
          .from(user)
          .where(inArray(user.id, ids))
      )
    ).then((r) => r.flat()),
    resolveReplyRefs(db, rows),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const scope = refs.get(scopeRefKey(r));
    if (!scope) throw new Error("Channel identity unavailable");
    const channel = scope.ref;
    const author = userById.get(r.authorId);
    const sender = author ? `@${formatHandle(author.name, author.discriminator)}` : "Deleted user";
    // Absent (not empty array) when a message has no attachments — smaller
    // wire payload; documented invariant in the plan.
    const atts = attachmentsByMessageId?.get(r.id);
    const decisionCard = r.type === DECISION_CARD_MESSAGE_TYPE
      ? extractDecisionCardFromEmbeds(parseRawEmbedsArray(r.embeds)).card
      : undefined;
    const content: MessageContent = decisionCard
      ? { question: toDecisionCardAgentPayload(decisionCard) }
      : { text: r.content };
    if (atts && atts.length > 0) content.attachments = atts;
    const replyTo = r.replyToId ? replyByMessageId.get(r.replyToId) : undefined;
    if (replyTo) content.replyTo = replyTo;
    const forumReplyRef = scope.isForum ? `${channel}/${formatSeq(r.seq)}` : null;
    return {
      seq: formatSeq(r.seq),
      channel,
      sender,
      content,
      ...(forumReplyRef
        ? {
            hint: `This is a forum post, please reply in ${forumReplyRef}.`,
          }
        : {}),
      time: r.createdAt,
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

  const idsByScope = new Map<string, { scope: MessageScope; ids: Set<string> }>();
  for (const r of rows) {
    if (!r.replyToId) continue;
    const scope: MessageScope = { channelId: r.channelId };
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
 * (`buildUnreadWakeCommand`, minimal-wake-queue-unread-notice plan §4).
 * A wake command's notice channel must NEVER be a placeholder — a missing
 * channel, missing DM, missing parent
 * channel, or missing parent message for a thread all resolve to `null` so
 * the caller treats it as `notice_channel_unresolvable` (ack/skip) rather
 * than waking an agent with a bogus ref it can't `inboxPull` against.
 */
export async function resolveUnreadNoticeChannel(
  db: Database,
  scope: { channelId: string },
  botUserId: string
): Promise<ChannelRef | null> {
  const rows = await db
    .select({
      id: communityChannel.id,
      name: communityChannel.name,
      type: communityChannel.type,
      serverId: communityChannel.serverId,
      parentChannelId: communityChannel.parentChannelId,
      parentMessageId: communityChannel.parentMessageId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, scope.channelId))
    .limit(1);
  const ch = rows[0];
  if (!ch) return null;

  // Same single canonical-ref emitter as `resolveScopeRefs` (B1): this function
  // does the I/O to gather the addressing context (DM peer, thread parent+root,
  // forum parent, server name), then hands it to `formatCanonicalRef` to pick
  // the ref SHAPE from the addressing trait. Its stricter no-placeholder
  // contract (see doc comment: a missing field is `notice_channel_unresolvable`,
  // never a bogus ref) matches the emitter's `null`-on-missing-field return —
  // so any unresolved piece below returns null exactly as before.
  const storedType = (ch.type ?? "text") as StoredChannelType;

  // DM channel — the notice ref is `/.dm/<peer#0042>`, the OTHER access member.
  if (storedType === "dm") {
    const peerRows = await db
      .select({ name: user.name, discriminator: user.discriminator })
      .from(communityChannelMember)
      .innerJoin(user, eq(user.id, communityChannelMember.userId))
      .where(
        and(
          eq(communityChannelMember.channelId, ch.id),
          eq(communityChannelMember.relation, "access"),
          ne(communityChannelMember.userId, botUserId)
        )
      )
      .limit(1);
    const peer = peerRows[0];
    if (!peer) return null;
    return formatCanonicalRef({ type: "dm", peerSegment: formatHandle(peer.name, peer.discriminator) });
  }

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
    if (!parent || !root || !parent.serverId) return null;
    const serverHandle = await getServerHandle(db, parent.serverId);
    if (!serverHandle) return null;
    return formatCanonicalRef({ type: "thread", serverHandle, parentName: parent.name, rootSeq: root.seq });
  }

  if (!ch.serverId) return null;
  const serverHandle = await getServerHandle(db, ch.serverId);
  if (!serverHandle) return null;
  return formatCanonicalRef({ type: storedType, serverHandle, name: ch.name ?? undefined });
}

async function getServerHandle(db: Database, serverId: string): Promise<string | null> {
  const rows = await db
    .select({ name: communityServer.name, discriminator: communityServer.discriminator })
    .from(communityServer)
    .where(eq(communityServer.id, serverId))
    .limit(1);
  return rows[0] ? formatHandle(rows[0].name, rows[0].discriminator) : null;
}

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
export async function getLatestSeqForScope(db: Database, channelId: string): Promise<Seq> {
  const rows = await db
    .select({ nextSeq: communityMessageSeq.nextSeq })
    .from(communityMessageSeq)
    .where(eq(communityMessageSeq.channelId, channelId));
  return rows[0]?.nextSeq ?? 0;
}

/**
 * Effective allowed channel-id set for a bot: visible channels MINUS child
 * threads where it holds no `community_channel_member(relation='notify')`
 * row. Pushes the notification-set narrowing into a pre-computed set so it can join the
 * message SQL as a single `inArray` predicate — the old shape did the
 * narrowing as a JS post-filter AFTER `.limit(max)`, which silently
 * collapsed a page of non-notified rows to `[]` (breaking `hasMore` in
 * `inboxPull`) and could return `null` from `getLatestUnreadMessageForAgent`
 * when older notified unread existed outside the top-N-by-createdAt
 * candidate window.
 */
export async function listAccessVisibleChannelIdsForUser(
  db: Database,
  userId: string
): Promise<string[]> {
  const serverChannelIds = await listVisibleChannelIdsForUser(db, userId);
  const dmChannelIds = await listDmChannelIdsForUser(db, userId);
  return [...new Set([...serverChannelIds, ...dmChannelIds])];
}

type AgentChannelsByPolicy = {
  allIds: string[];
  mentionsIds: string[];
};

async function resolveAgentDeliverableChannelsByPolicy(
  db: Database,
  botUserId: string,
  accessVisibleChannelIds?: string[]
): Promise<AgentChannelsByPolicy> {
  const visibleChannelIds = accessVisibleChannelIds
    ?? await listAccessVisibleChannelIdsForUser(db, botUserId);

  const uniqueVisibleIds = [...new Set(visibleChannelIds)];
  if (uniqueVisibleIds.length === 0) return { allIds: [], mentionsIds: [] };

  const [typeRows, settings] = await Promise.all([
    db
      .select({
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      })
      .from(communityChannel)
      .where(inArray(communityChannel.id, jsonTextSet(db, uniqueVisibleIds))),
    loadUserNotificationSettingLookup(db, botUserId),
  ]);
  const narrowIds = typeRows
    .filter((r) => reachIsParticipantSet(r.type))
    .map((r) => r.id);
  const notifiedChannelIds =
    narrowIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, narrowIds, botUserId))
      : new Set<string>();
  const narrowSet = new Set(narrowIds);

  const allIds: string[] = [];
  const mentionsIds: string[] = [];
  for (const ch of typeRows) {
    if (narrowSet.has(ch.id) && !notifiedChannelIds.has(ch.id)) continue;
    const level = resolveEffectiveNotificationLevel(settings, ch);
    if (level === "all") allIds.push(ch.id);
    else if (level === "mentions") mentionsIds.push(ch.id);
  }
  return { allIds, mentionsIds };
}

const channelJoinBaselineGuard = sql`${communityMessage.createdAt} > COALESCE(${communityChannelMember.addedAt}, ${communityServerMember.joinedAt}, '')`;

export async function listUnreadMessagesForAgent(
  db: Database,
  botUserId: string,
  opts: { max: number; visibleChannelIds?: string[] }
): Promise<RawAgentMessage[]> {
  const { allIds, mentionsIds } = await resolveAgentDeliverableChannelsByPolicy(
    db,
    botUserId,
    opts.visibleChannelIds
  );
  if (allIds.length === 0 && mentionsIds.length === 0) return [];

  const runPolicyGroup = (ids: string[], mentionsOnly: boolean) =>
    db
      .select({
        ...AGENT_MESSAGE_COLUMNS,
        lastReadSeq: sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`,
      })
      .from(communityChannel)
      .innerJoin(communityMessage, eq(communityMessage.channelId, communityChannel.id))
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityChannel.id)
        )
      )
      .leftJoin(
        communityChannelMember,
        and(
          eq(communityChannelMember.channelId, communityChannel.id),
          eq(communityChannelMember.userId, botUserId),
          eq(communityChannelMember.relation, "access")
        )
      )
      .leftJoin(
        communityServerMember,
        and(
          eq(communityServerMember.serverId, communityChannel.serverId),
          eq(communityServerMember.userId, botUserId)
        )
      )
      .where(
        and(
          inArray(communityChannel.id, jsonTextSet(db, ids)),
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          channelJoinBaselineGuard,
          ...(mentionsOnly ? [hasAttentionSql(botUserId, communityMessage.id)] : []),
        )
      )
      .orderBy(asc(communityMessage.channelId), asc(communityMessage.seq))
      .limit(opts.max);

  const [allRows, mentionRows] = await Promise.all([
    allIds.length > 0 ? runPolicyGroup(allIds, false) : Promise.resolve([]),
    mentionsIds.length > 0 ? runPolicyGroup(mentionsIds, true) : Promise.resolve([]),
  ]);
  const merged = [...allRows, ...mentionRows];
  merged.sort((a, b) =>
    a.channelId === b.channelId
      ? a.seq - b.seq
      : a.channelId < b.channelId
        ? -1
        : 1
  );
  return merged
    .slice(0, opts.max)
    .map(({ lastReadSeq: _lastReadSeq, ...rest }) => rest);
}

export async function hasDeliverableUnreadForAgentScope(
  db: Database,
  botUserId: string,
  channelId: string,
  seen: number
): Promise<boolean> {
  const [typeRows, settings] = await Promise.all([
    db
      .select({
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      })
      .from(communityChannel)
      .where(eq(communityChannel.id, channelId))
      .limit(1),
    loadUserNotificationSettingLookup(db, botUserId),
  ]);
  const channel = typeRows[0];
  if (!channel) return false;

  const level = resolveEffectiveNotificationLevel(settings, channel);
  if (level !== "all" && level !== "mentions") return false;

  if (reachIsParticipantSet(channel.type)) {
    const participating = await listParticipatingThreadIds(db, [channelId], botUserId);
    if (participating.length === 0) return false;
  }

  const rows = await db
    .select({ seq: communityMessage.seq })
    .from(communityMessage)
    .leftJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .leftJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityMessage.channelId),
        eq(communityChannelMember.userId, botUserId),
        eq(communityChannelMember.relation, "access")
      )
    )
    .leftJoin(
      communityServerMember,
      and(
        eq(communityServerMember.serverId, communityChannel.serverId),
        eq(communityServerMember.userId, botUserId)
      )
    )
    .where(
      and(
        eq(communityMessage.channelId, channelId),
        ne(communityMessage.authorId, botUserId),
        gt(communityMessage.seq, seen),
        channelJoinBaselineGuard,
        ...(level === "mentions" ? [hasAttentionSql(botUserId, communityMessage.id)] : []),
      )
    )
    .limit(1);

  return rows.length > 0;
}

export type InboxSnapshotRow = {
  channelId: string;
  pendingCount: number;
  firstPendingSeq: number;
  latestSeq: number;
  latestSender: string;
  hasMention: boolean;
};

export async function getInboxSnapshotForAgent(
  db: Database,
  botUserId: string,
  opts?: { accessVisibleChannelIds?: string[] },
): Promise<InboxSnapshotRow[]> {
  const { allIds, mentionsIds } = await resolveAgentDeliverableChannelsByPolicy(
    db,
    botUserId,
    opts?.accessVisibleChannelIds,
  );
  if (allIds.length === 0 && mentionsIds.length === 0) return [];

  const runSnapshotGroup = (ids: string[], mentionsOnly: boolean) => {
    const pending = db
      .select({
        channelId: communityMessage.channelId,
        pendingCount: sql<number>`COUNT(*)`.as("pending_count"),
        firstPendingSeq: sql<number>`MIN(${communityMessage.seq})`.as("first_pending_seq"),
        latestSeq: sql<number>`MAX(${communityMessage.seq})`.as("latest_seq"),
        mentionCount: sql<number>`SUM(CASE WHEN ${hasDirectMentionSql(botUserId, communityMessage.id)} THEN 1 ELSE 0 END)`.as("mention_count"),
      })
      .from(communityChannel)
      .innerJoin(communityMessage, eq(communityMessage.channelId, communityChannel.id))
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityChannel.id)
        )
      )
      .leftJoin(
        communityChannelMember,
        and(
          eq(communityChannelMember.channelId, communityChannel.id),
          eq(communityChannelMember.userId, botUserId),
          eq(communityChannelMember.relation, "access")
        )
      )
      .leftJoin(
        communityServerMember,
        and(
          eq(communityServerMember.serverId, communityChannel.serverId),
          eq(communityServerMember.userId, botUserId)
        )
      )
      .where(
        and(
          inArray(communityChannel.id, jsonTextSet(db, ids)),
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          channelJoinBaselineGuard,
          ...(mentionsOnly ? [hasAttentionSql(botUserId, communityMessage.id)] : []),
        )
      )
      .groupBy(communityMessage.channelId)
      .as("pending_inbox");

    return db
      .select({
        channelId: pending.channelId,
        pendingCount: pending.pendingCount,
        firstPendingSeq: pending.firstPendingSeq,
        latestSeq: pending.latestSeq,
        mentionCount: pending.mentionCount,
        sender: {
          id: user.id,
          name: user.name,
          discriminator: user.discriminator,
        },
      })
      .from(pending)
      .innerJoin(communityMessage, and(
        eq(communityMessage.channelId, pending.channelId),
        eq(communityMessage.seq, pending.latestSeq),
      ))
      .leftJoin(user, eq(user.id, communityMessage.authorId));
  };

  const [allRows, mentionRows] = await Promise.all([
    allIds.length > 0 ? runSnapshotGroup(allIds, false) : Promise.resolve([]),
    mentionsIds.length > 0 ? runSnapshotGroup(mentionsIds, true) : Promise.resolve([]),
  ]);

  return [...allRows, ...mentionRows].map((r) => ({
    channelId: r.channelId,
    pendingCount: r.pendingCount,
    firstPendingSeq: r.firstPendingSeq,
    latestSeq: r.latestSeq,
    latestSender: r.sender?.id ? `@${formatHandle(r.sender.name, r.sender.discriminator)}` : "Deleted user",
    hasMention: r.mentionCount > 0,
  }));
}

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
    if (!scope) throw new Error("Channel identity unavailable");
    const flags: Array<"dm" | "thread" | "mention"> = [];
    if (scope?.isDm) flags.push("dm");
    if (scope?.isThread) flags.push("thread");
    if (r.hasMention) flags.push("mention");
    return {
      channel: scope.ref,
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
 * able to see the channel (`listVisibleChannelIdsForUser`) AND, for child
 * threads, hold a `community_channel_member(relation='notify')` row. Both
 * dimensions are folded into the SQL WHERE via `listAgentAllowedChannelIds`
 * so `LIMIT 1` returns the newest allowed row directly — an earlier shape
 * used a bounded post-filter window that could return `null` when older
 * allowed unread existed outside the top-N-by-createdAt slice. Notification
 * eligibility is applied before `LIMIT 1` too, so a newer muted row cannot
 * obscure an older eligible unread during daemon reconnect resync.
 */
export async function getLatestUnreadMessageForAgent(
  db: Database,
  botUserId: string,
  opts?: { accessVisibleChannelIds?: string[] },
): Promise<{ messageId: string } | null> {
  const { allIds, mentionsIds } = await resolveAgentDeliverableChannelsByPolicy(
    db,
    botUserId,
    opts?.accessVisibleChannelIds,
  );
  if (allIds.length === 0 && mentionsIds.length === 0) return null;

  const runPolicyGroup = (ids: string[], mentionsOnly: boolean) =>
    db
      .select({
        id: communityMessage.id,
        createdAt: communityMessage.createdAt,
      })
      .from(communityChannel)
      .innerJoin(communityMessage, eq(communityMessage.channelId, communityChannel.id))
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityChannel.id)
        )
      )
      .leftJoin(
        communityChannelMember,
        and(
          eq(communityChannelMember.channelId, communityChannel.id),
          eq(communityChannelMember.userId, botUserId),
          eq(communityChannelMember.relation, "access")
        )
      )
      .leftJoin(
        communityServerMember,
        and(
          eq(communityServerMember.serverId, communityChannel.serverId),
          eq(communityServerMember.userId, botUserId)
        )
      )
      .where(
        and(
          inArray(communityChannel.id, jsonTextSet(db, ids)),
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          channelJoinBaselineGuard,
          ...(mentionsOnly ? [hasAttentionSql(botUserId, communityMessage.id)] : []),
        )
      )
      .orderBy(desc(communityMessage.createdAt))
      .limit(1);

  const [allWinners, mentionWinners] = await Promise.all([
    allIds.length > 0 ? runPolicyGroup(allIds, false) : Promise.resolve([]),
    mentionsIds.length > 0 ? runPolicyGroup(mentionsIds, true) : Promise.resolve([]),
  ]);
  const winners = [...allWinners, ...mentionWinners];
  if (winners.length === 0) return null;
  let best = winners[0]!;
  for (const w of winners) if (w.createdAt > best.createdAt) best = w;
  return { messageId: best.id };
}

/**
 * Seq-anchored pagination for `read` — the existing `listMessages` orders by
 * `createdAt` and has no `around` support, so this is a dedicated query.
 * Exactly one of `before`/`after`/`around` should be set (validated at the
 * Zod layer); `around` centers the window and ignores the other two.
 */
export async function listMessagesBySeq(
  db: Database,
  target: { channelId: string },
  opts: { before?: Seq; after?: Seq; around?: Seq; limit?: number }
): Promise<{ items: RawAgentMessage[]; hasMore: boolean; latestSeq?: Seq }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const scopeCond = eq(communityMessage.channelId, target.channelId);
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

    if (opts.after !== undefined) items = items.slice(0, limit);
    else items = items.slice(items.length - limit);
  }

  // `Page.latestSeq` is documented as "seq of the newest item in THIS page,
  // for advancing a cursor" (`community-cli-contract.ts`) — not the scope's
  // global latest (that's `getLatestSeqForScope`, a different call for a
  // different purpose: the `send` route's alignment gate). `items` is always
  // seq-ascending by construction above (all four branches sort/reverse to
  // ascending before returning), so the newest item is the last one.
  const latestSeq = items.length > 0 ? items[items.length - 1]!.seq : undefined;

  return { items, hasMore, latestSeq };
}
