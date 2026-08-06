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
import { formatHandle } from "../../../lib/discriminator";
import { listVisibleChannelIdsForUser } from "./channel";
import { listParticipatingThreadIds } from "./thread";
import { getMessagesByIdsInScope, type MessageScope } from "./message";
import { reachIsParticipantSet, type StoredChannelType } from "../../../utils/community-roles";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { withD1Retry } from "../../resilience";

type RawAgentMessage = {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  channelId: string;
  seq: number;
  replyToId: string | null;
};

const AGENT_MESSAGE_COLUMNS = {
  id: communityMessage.id,
  authorId: communityMessage.authorId,
  content: communityMessage.content,
  createdAt: communityMessage.createdAt,
  channelId: communityMessage.channelId,
  seq: communityMessage.seq,
  replyToId: communityMessage.replyToId,
} as const;

/** One entry per distinct channel needing a `ChannelRef`. */
type ScopeInfo = { ref: string; isThread: boolean; isDm: boolean };

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
    // Ref SHAPE is chosen by the single canonical-ref emitter, keyed on the
    // channel type's addressing trait (B1, red-line ①) — this loop only gathers
    // the resolved context each addressing value may need (server/parent names,
    // DM peer segment, thread root seq). The `isThread`/`isDm` flags are a
    // separate presentation concern (inbox-row flags) and stay type-derived.
    const storedType = (ch.type ?? "text") as StoredChannelType;
    const isDm = storedType === "dm";
    let peerSegment: string | undefined;
    if (isDm) {
      const peerId = peerByDmChannel.get(ch.id);
      const peer = peerId ? dmPeerById.get(peerId) : undefined;
      peerSegment = peer ? formatHandle(peer.name, peer.discriminator) : peerId || "unknown";
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
    // Degraded channel (emitter null — a required addressing field didn't
    // hydrate, e.g. a thread missing its parent/root): skip its ENTRY in this
    // channelId→ScopeInfo map. This is safe for never-drop: the map is looked
    // up per message row by the two callers as `scope?.ref ?? "/unknown/<id>"`,
    // which already keep the row and emit the explicit "/unknown/" sentinel when
    // the scope is absent. So a missing entry funnels into that existing
    // unresolvable path — the message row survives (nothing is dropped from the
    // page) and its channel reads as an explicit "unresolvable" sentinel, NOT a
    // hand-built top-level ref that looks addressable but 404s. This removes the
    // second place the top-level ref shape was built (B1.1): the shape now lives
    // ONLY in the emitter.
    if (ref === null) continue;
    out.set(ch.id, {
      ref,
      isThread: emitType === "thread",
      isDm,
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
  // Group each row's replyToId by the row's OWN channel scope.
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
export async function getLatestSeqForScope(db: Database, channelId: string): Promise<Seq> {
  const rows = await db
    .select({ nextSeq: communityMessageSeq.nextSeq })
    .from(communityMessageSeq)
    .where(eq(communityMessageSeq.channelId, channelId));
  return rows[0]?.nextSeq ?? 0;
}

/**
 * Effective allowed channel-id set for a bot: visible channels MINUS
 * child threads the bot isn't a participant of. Pushes the
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

  // DM channels the bot holds a relation='access' row on — DMs are channels
  // now, so they're not covered by `listVisibleChannelIdsForUser` (which walks
  // server memberships). A DM has no thread/forum narrowing.
  const dmRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.userId, botUserId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm")
      )
    );
  const dmChannelIds = dmRows.map((r) => r.channelId);

  if (visibleChannelIds.length === 0) return dmChannelIds;

  // Chunk the `inArray` for D1's 100-param limit; no order/limit → concat.
  const typeRows = (
    await Promise.all(
      chunk(visibleChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({ id: communityChannel.id, type: communityChannel.type })
          .from(communityChannel)
          .where(inArray(communityChannel.id, ids))
      )
    )
  ).flat();
  // Participation-narrowed types = reach `participant-set` (B2 single source),
  // not a re-derived `isThread || isForumPost`. A participant-set channel is
  // deliverable to the bot only if it holds a notify row — the SAME reach value
  // the fan-out recipient set and the send-path enroll key on.
  const narrowIds = typeRows
    .filter((r) => reachIsParticipantSet(r.type))
    .map((r) => r.id);
  const participating =
    narrowIds.length > 0
      ? new Set(await listParticipatingThreadIds(db, narrowIds, botUserId))
      : new Set<string>();
  const narrowSet = new Set(narrowIds);
  const serverAllowed = visibleChannelIds.filter((id) => !narrowSet.has(id) || participating.has(id));
  return [...serverAllowed, ...dmChannelIds];
}

/**
 * The "message is at/after the bot's join baseline" guard for the channel arm,
 * expressed over the LEFT-JOINed membership rows (see `withJoinBaseline`).
 * Mirrors the human unread baseline (`inbox.ts` `lastMessageAt > joinedAt`): a
 * bot's unread must start at the moment it JOINED, not at seq 0 — otherwise a
 * bot added to a server/channel with backlog gets flooded with all history
 * (the agent predicate keys on `seq > COALESCE(lastReadSeq,0)`, and a fresh
 * member has no read-state row → baseline 0 → every message matches).
 *
 * Baseline precedence: the private-channel access row's `added_at` when present
 * (bot explicitly added to that channel), else the server-member `joined_at`
 * for the channel's server. If neither exists (shouldn't happen for an allowed
 * channel), COALESCE falls to `''` → any ISO `createdAt > ''` is true → fail
 * open to the pre-existing behavior, never wrongly suppressing. Strict `>`: a
 * message whose `createdAt` exactly equals the join timestamp is NOT unread.
 */
const channelJoinBaselineGuard = sql`${communityMessage.createdAt} > COALESCE(${communityChannelMember.addedAt}, ${communityServerMember.joinedAt}, '')`;

/**
 * Cross-channel unread fill for `inboxPull`, grouped by channel/DM (not
 * global seq order — `seq` is a per-scope counter, comparing raw values
 * across scopes is meaningless, see plan §7 v4). Always drains one channel's
 * unread completely (in seq order) before starting the next. Excludes the
 * bot's own authored messages. Never mutates read state.
 *
 * Visibility rule: same as the human unread path (`listUnreadChannels`) —
 * (1) channel messages restricted to `listVisibleChannelIdsForUser(botUserId)`
 * (respects private-category rosters), and
 * (2) child threads additionally require a
 * `community_channel_member(relation='notify')` row for the bot. Both dimensions are folded
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
  if (allowedChannelIds.length === 0) return [];

  // D1 caps a statement at 100 bound params, and `allowedChannelIds` is
  // unbounded (a bot allowed into >100 channels). Chunk the `inArray` and merge:
  // each chunk runs the SAME order+limit; since chunks partition channel ids,
  // each chunk's result is a subsequence of the global (channelId, seq) order,
  // so the global top-`max` is contained in the union of per-chunk top-`max`.
  // Re-sort the union and slice to `max`. Both sort keys are in the projection.
  const runChunk = (ids: string[]) =>
    db
      .select({
        ...AGENT_MESSAGE_COLUMNS,
        lastReadSeq: sql<number>`COALESCE(${communityReadState.lastReadSeq}, 0)`,
      })
      .from(communityMessage)
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityMessage.channelId)
        )
      )
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
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          inArray(communityMessage.channelId, ids),
          channelJoinBaselineGuard
        )
      )
      .orderBy(asc(communityMessage.channelId), asc(communityMessage.seq))
      .limit(opts.max);

  const merged = (
    await Promise.all(chunk(allowedChannelIds, D1_MAX_IN_PARAMS).map(runChunk))
  ).flat();
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

/**
 * Does `botUserId` have any message in `channelId`, beyond seq `seen`, that
 * `inboxPull` would actually DELIVER — i.e. at/after the bot's join baseline
 * and not its own? This is the send route's alignment gate, sharing
 * `listUnreadMessagesForAgent`'s DELIVERABILITY filters (`channelJoinBaselineGuard`
 * + `authorId != bot`) so the gate and the pull can never drift on which
 * messages "count". The `seen` threshold is the gate's own business: the caller
 * passes `seenUpToSeq ?? lastReadSeq ?? 0`, preserving the daemon's forward-seen
 * boundary (a bot may report it has seen past its acked `lastReadSeq`).
 *
 * Why not `getLatestSeqForScope > seen`: that counts the channel's raw `nextSeq`
 * — including pre-join backlog and the bot's own messages — which the pull's
 * baseline + author filters exclude. A bot @mentioned into a channel/thread with
 * history would then read as permanently "unaligned" (gate sees backlog) while
 * `inboxPull` delivers nothing to advance its `lastReadSeq` — a wedge that only
 * luck (a fresh post-join message) breaks. Gating on the deliverable predicate
 * makes the wedge impossible by construction and needs no read-state migration
 * for already-stuck bots: the gate stops counting messages the pull never hands
 * over.
 *
 * Child-thread participation narrowing: the pull's allowed set
 * (`listAgentAllowedChannelIds`) additionally drops child threads
 * the bot holds no `relation='notify'` row on — those are never delivered. The
 * gate MUST mirror that same narrowing (via the SAME `listParticipatingThreadIds`
 * predicate, not a re-derived one) or it counts backlog in a non-participated
 * thread that the pull will never hand over — the exact "not aligned: N unread"
 * deadlock a bot hit trying to post into a thread it hadn't engaged. This drops
 * ONLY true spectators: a bot @mentioned into a thread gets a `notify` row on the
 * send hot path (`addThreadParticipants`, source=mention), so its owed mention
 * still counts as deliverable — the narrowing is not-more-not-less than the pull.
 */
export async function hasDeliverableUnreadForAgentScope(
  db: Database,
  botUserId: string,
  channelId: string,
  seen: number
): Promise<boolean> {
  // Participation narrowing, single-channel form of `listAgentAllowedChannelIds`'s
  // set-wide step: a child thread the bot doesn't participate in is never
  // deliverable, so its backlog must not register as unread here. Short-circuits
  // before the deliverable scan — cheaper for the common spectator case too.
  const typeRows = await db
    .select({ type: communityChannel.type })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId))
    .limit(1);
  const type = typeRows[0]?.type;
  // Same reach `participant-set` narrowing as `listAgentAllowedChannelIds` — via
  // the SAME reachIsParticipantSet source (B2). This gate and the pull's allowed
  // set MUST agree on which channels need a notify row to be deliverable, or the
  // gate counts backlog the pull never delivers (the send-alignment deadlock).
  // Reading one shared reach value is what makes that agreement structural.
  if (reachIsParticipantSet(type)) {
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
        channelJoinBaselineGuard
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

/**
 * Per-channel/DM unread summary for `inboxSnapshot` — non-consuming, no read-
 * state mutation. One row per scope with pending unread.
 *
 * Visibility rule mirrors `listUnreadMessagesForAgent`: (1) channel scopes
 * restricted to `listVisibleChannelIdsForUser(botUserId)`, and (2) scopes of
 * child threads additionally require a
 * `community_channel_member(relation='notify')` row for the bot (post-filter). Because the
 * outer `WHERE` is `inArray(channelId, visibleChannelIds)` and non-participated
 * thread rows are dropped in the post-filter, `hasMention` (a correlated
 * sub-select keyed on the surviving row's `channel_id`) can never inherit a
 * mention from an invisible or non-participated thread — do NOT try to
 * sub-select mentions independently or the leak reopens on this axis.
 */
export async function getInboxSnapshotForAgent(db: Database, botUserId: string): Promise<InboxSnapshotRow[]> {
  const allowedChannelIds = await listAgentAllowedChannelIds(db, botUserId);
  if (allowedChannelIds.length === 0) return [];

  // Chunk the `inArray` for D1's 100-param limit. GROUP BY channelId partitions
  // cleanly across chunks — a channel id lands in exactly one chunk, so its
  // COUNT/MIN/MAX and the correlated subselects are complete within that chunk.
  // Concat is loss-free (no channel appears in two chunks).
  const runChunk = (ids: string[]) =>
    db
      .select({
        channelId: communityMessage.channelId,
        pendingCount: sql<number>`COUNT(*)`,
        firstPendingSeq: sql<number>`MIN(${communityMessage.seq})`,
        latestSeq: sql<number>`MAX(${communityMessage.seq})`,
        latestSenderId: sql<string>`(SELECT author_id FROM community_message m2
          WHERE m2.channel_id = ${communityMessage.channelId}
          ORDER BY m2.seq DESC LIMIT 1)`,
        mentionCount: sql<number>`(SELECT COUNT(*) FROM community_mention cm
          INNER JOIN community_message m3 ON m3.id = cm.message_id
          WHERE cm.user_id = ${botUserId} AND cm.kind = 'mention'
            AND m3.channel_id = ${communityMessage.channelId}
            AND m3.seq > COALESCE(${communityReadState.lastReadSeq}, 0))`,
      })
      .from(communityMessage)
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityMessage.channelId)
        )
      )
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
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          inArray(communityMessage.channelId, ids),
          channelJoinBaselineGuard
        )
      )
      .groupBy(communityMessage.channelId);

  const rows = (
    await Promise.all(chunk(allowedChannelIds, D1_MAX_IN_PARAMS).map(runChunk))
  ).flat();

  if (rows.length === 0) return [];

  const filtered = rows;

  const senderIds = [...new Set(filtered.map((r) => r.latestSenderId).filter(Boolean))];
  // Chunk the `inArray` for D1's 100-param limit — one distinct sender per
  // pending channel, so >100 channels yields >100 ids; no order/limit → concat.
  const users = senderIds.length
    ? (
        await Promise.all(
          chunk(senderIds, D1_MAX_IN_PARAMS).map((ids) =>
            db
              .select({ id: user.id, name: user.name, discriminator: user.discriminator })
              .from(user)
              .where(inArray(user.id, ids))
          )
        )
      ).flat()
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return filtered.map((r) => {
    const sender = userById.get(r.latestSenderId);
    return {
      channelId: r.channelId,
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
    if (scope?.isDm) flags.push("dm");
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
 * able to see the channel (`listVisibleChannelIdsForUser`) AND, for child
 * threads, hold a `community_channel_member(relation='notify')` row. Both
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
  if (allowedChannelIds.length === 0) return null;

  // Chunk the `inArray` for D1's 100-param limit; each chunk returns its own
  // newest-by-createdAt winner (LIMIT 1). To pick the GLOBAL winner across
  // chunks we must compare `createdAt`, so it's added to the projection (the
  // original selected only `id` and couldn't be merged).
  const runChunk = (ids: string[]) =>
    db
      .select({
        id: communityMessage.id,
        createdAt: communityMessage.createdAt,
      })
      .from(communityMessage)
      .leftJoin(
        communityReadState,
        and(
          eq(communityReadState.userId, botUserId),
          eq(communityReadState.channelId, communityMessage.channelId)
        )
      )
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
          ne(communityMessage.authorId, botUserId),
          sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
          inArray(communityMessage.channelId, ids),
          channelJoinBaselineGuard
        )
      )
      .orderBy(desc(communityMessage.createdAt))
      .limit(1);

  const winners = (
    await Promise.all(chunk(allowedChannelIds, D1_MAX_IN_PARAMS).map(runChunk))
  ).flat();
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
    // Trim the extra probe row from whichever end we over-fetched from.
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
