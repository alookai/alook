import {
  queries,
  extractMentionedUserIds,
  isMentionType,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PARTICIPANT_SOURCE,
  MENTION_KIND,
  createLogger,
  isUniqueConstraintError,
  withD1Retry,
  reachIsParticipantSet,
  WS_EVENTS,
} from "@alook/shared"
import type { MentionType } from "@alook/shared"
import type { Database } from "@alook/shared"
import { dispatchCommittedMessage } from "./message-dispatcher"
import { attachmentThumbnailUrl, attachmentUrl } from "./storage"
import { broadcastToUserSafe, fanOutToChannel } from "./fanout"

const log = createLogger({ service: "community-message-handler" })

export type MessageTarget =
  | { kind: "channel"; channelId: string; serverId: string }
  | {
    kind: "thread"
    channelId: string
    parentChannelId: string
    serverId: string
  }
  | { kind: "dm"; channelId: string; otherUserId: string }
  // A top-level `forum`-type channel (parentChannelId is null — it's still
  // the addressed channel itself, not a child under it; peer to "channel",
  // not to "thread" which carries a parent). Split out from the generic
  // "channel" kind so the SEND layer can dispatch "does this send open a
  // thread" off the target's own structural kind — the same channel.type the
  // door already resolved — instead of an ad-hoc body field. A body field's
  // presence is a client choice, decoupled from the channel's actual type;
  // branching on the target's own kind here means there is only ever one
  // axis deciding this, not two that can drift apart.
  | { kind: "forum"; channelId: string; serverId: string }

export function isDmTarget<T extends { kind: string }>(target: T): target is Extract<T, { kind: "dm" }>
export function isDmTarget(kind: string): boolean
export function isDmTarget(target: { kind: string } | string): boolean {
  return (typeof target === "string" ? target : target.kind) === "dm"
}

export function isThreadTarget<T extends { kind: string }>(target: T): target is Extract<T, { kind: "thread" }>
export function isThreadTarget(kind: string): boolean
export function isThreadTarget(target: { kind: string } | string): boolean {
  return (typeof target === "string" ? target : target.kind) === "thread"
}

export function isChannelTarget<T extends { kind: string }>(target: T): target is Extract<T, { kind: "channel" }>
export function isChannelTarget(kind: string): boolean
export function isChannelTarget(target: { kind: string } | string): boolean {
  return (typeof target === "string" ? target : target.kind) === "channel"
}

export type IncomingMessageBody = {
  content?: unknown
  replyToId?: unknown
  mentionType?: unknown
}

type CreatedAttachment = {
  id: string
  filename: string
  url: string
  thumbnailUrl?: string
  contentType: string | null
  size: number | null
  width?: number | null
  height?: number | null
}

async function hydrateStoredAttachments(db: Database, messageId: string): Promise<CreatedAttachment[]> {
  const rows = await queries.communityAttachment.listByMessageIds(db, [messageId])
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    url: attachmentUrl(row.targetId, row.id),
    ...(row.thumbnailR2Key ? { thumbnailUrl: attachmentThumbnailUrl(row.targetId, row.id) } : {}),
    contentType: row.contentType,
    size: row.size,
    width: row.width,
    height: row.height,
  }))
}

export async function getCommunityMessageReplay(params: {
  db: Database
  authorId: string
  channelId: string
  clientNonce?: string
}): Promise<CreateMessageOk | null> {
  if (params.clientNonce === undefined) return null
  const existing = await withD1Retry(
    () => queries.communityMessage.getMessageByAuthorAndNonce(params.db, params.authorId, params.clientNonce!),
    { route: "message-handler:nonce-precheck" },
  )
  if (!existing || existing.channelId !== params.channelId) return null
  return {
    ok: true,
    row: existing,
    attachments: await hydrateStoredAttachments(params.db, existing.id),
    deduped: true,
  }
}

type FullMessageRow = NonNullable<
  Awaited<ReturnType<typeof queries.communityMessage.getMessage>>
>

type CreateMessageError = {
  ok: false
  status: 400 | 409
  error: string
}

type CreateMessageOk = {
  ok: true
  row: FullMessageRow
  attachments: CreatedAttachment[]
  /**
   * Present ONLY when the caller passed `deferBroadcast: true`. Invoking it
   * dispatches the committed message through the same D1-rehydrated delivery
   * plan that `createCommunityMessage` would otherwise schedule immediately.
   * Deferred producers invoke it only after their dependent row has committed.
   */
  broadcast?: () => Promise<void>
  /**
   * True when this result is an idempotent replay: a `clientNonce` matched an
   * already-committed message, so NO new seq was claimed and NO WS fan-out
   * fired — the returned `row` is the original. Absent/false on a fresh insert.
   */
  deduped?: boolean
}

export type CreateMessageResult = CreateMessageOk | CreateMessageError

/**
 * Unified message-create pipeline for channel, thread, and DM POSTs.
 *
 * Handles request-body validation, message + attachment inserts, reply
 * resolution, mention extraction (channel/thread only — DMs only flag the
 * reply target), participant writes, and one committed dispatcher call that
 * derives message, notification, wake, and parent projections from D1.
 *
 * Each route resolves permission/target first, then delegates here.
 */
export async function createCommunityMessage(params: {
  db: Database
  authorId: string
  /** Human writers mint/broadcast a bounded account read-state revision hint. */
  authorKind: "human" | "bot"
  target: MessageTarget
  body: IncomingMessageBody
  /** Provenance tag included in diagnostics when a requested reply target is out of scope. */
  source?: "cli" | "daemon-http" | "web"
  /**
   * CAS guard for the agent-send race fix
   * (plans/fix-agent-send-race-condition.md). Only the agent `send` route
   * passes this — it's the `latestSeq` snapshot that route's own alignment
   * check already computed. Omitted by every other caller (web/human sends,
   * thread posts), which keep the unconditional, always-succeeds claim.
   */
  expectedSeq?: number
  /**
   * Sets `communityMessage.type` (e.g. `"thread_created"`). Defaults to
   * `"default"` — every normal-message caller is untouched.
   */
  messageType?: string
  /**
   * Skip `@`/reply mention extraction + `communityMention` writes + the
   * `MENTION_CREATE` broadcast. System/card messages (thread_created, bot DM
   * cards) opt in — they never mention anyone.
   */
  skipMentions?: boolean
  /**
   * Reserve-by-id attachment path (the ONLY attachment path — human web and bot
   * both use it, route/disc step 2b). Pending attachment ids the caller has
   * already validated against (uploader, target). When present, the handler
   * pre-mints the message id, reserves the pending rows in a single atomic
   * UPDATE, then inserts the message — compensating unreserves on every failure
   * path so no message row is ever committed with a partial attachment set.
   */
  attachmentIds?: string[]
  /**
   * Do NOT run any WS side effect inline. Instead, on success, return a
   * `broadcast` thunk on the OK result the caller can invoke once its own
   * follow-up writes have committed. Used by the DM-card producers, which
   * persist an approval-request row after the message and roll it back on
   * conflict — broadcasting before that commit would show a phantom card.
   */
  deferBroadcast?: boolean
  /**
   * Migration-backfill mode: DROP every WS side effect entirely (MESSAGE_CREATE
   * fan-out, notify push, bot wake, CHILD_CHANNEL_UPDATE) — historical backfill
   * must not ping anyone or push M×N real-time frames. UNLIKE `deferBroadcast`,
   * which hands the caller a thunk to fire later, this simply never runs the
   * broadcast at all.
   *
   * CRITICAL (Aigneis #133 / Melly #135 / message-handler decouple at
   * `skipChildChannelUpdate`): this closes ONLY the real-time DELIVERY shell.
   * The STRUCTURAL core — the message row, thread open, and the notify-set
   * ENROLL (`addThreadParticipants`, the reach-axis participant write) + mention
   * ROW writes — all run inline ABOVE the broadcast block and are NOT gated by
   * this flag. Do NOT reach for `skipMentions` to silence a backfill: that flag
   * ALSO closes enroll + mention rows (`!skipMentions` at the enroll gate), which
   * would silently drop the migrated thread's participant set. Keep this flag
   * about DELIVERY only, so a migrated post's participants (opener + each reply's
   * author/mention) are identical to the new-build path.
   *
   * Built for the forum carrier-swap migration entry (route/disc trunk); no
   * real-time caller passes it, so real-time create behavior is unchanged.
   */
  suppressBroadcast?: boolean
  /**
   * Suppress ONLY the parent `CHILD_CHANNEL_UPDATE` WS emission — participant
   * enroll (the notify-set write) still runs per `kind`. A thread-open's
   * first message opts in when the caller already emits its own
   * CHILD_CHANNEL_CREATE for the new thread (the two would otherwise
   * collide). Decouples enroll from the WS tick so dodging the collision no
   * longer silently skips enrollment.
   */
  skipChildChannelUpdate?: boolean
  /**
   * Idempotency key (mutation-idempotency plan). When present, the handler
   * dedupes on (author, nonce) BEFORE claiming a seq: a resend carrying a
   * nonce that already committed returns the original row with `deduped: true`
   * and fires no side effects. Absent = today's behavior (no dedup lookup).
   */
  clientNonce?: string
  /**
   * Extra Drizzle statements to commit in the SAME batch as the message insert
   * (zero new round-trip). Threaded straight into `createMessage`. The bot-send
   * routes use this to bump the per-day sent-activity heatmap rollup; human
   * sends pass nothing. Runs only if the row is written (shares the batch's
   * all-or-nothing fate; a lost CAS seq claim skips it). This handler stays
   * identity-agnostic — the bot-only caller supplies the statement.
   */
  extraStatements?: unknown[]
  suppressThreadFanout?: boolean
  forumThread?: Parameters<typeof queries.communityMessage.createMessage>[1]["forumThread"]
}): Promise<CreateMessageResult> {
  const {
    db,
    authorId,
    authorKind,
    target,
    body,
    source,
    expectedSeq,
    messageType,
    skipMentions,
    deferBroadcast,
    suppressBroadcast,
    attachmentIds,
    skipChildChannelUpdate,
    clientNonce,
    extraStatements,
  } = params

  const content = typeof body.content === "string" ? body.content : ""
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
    }
  }

  // Reserve-by-id is the SINGLE attachment path (route/disc step 2b unified the
  // human composer onto the bot flow): every caller — human web AND bot — passes
  // pre-uploaded pending-row ids via `attachmentIds`; the route already validated
  // them against (uploader, target). There is no longer a url-carried inline
  // attachment path.
  const attachmentIdCount = Array.isArray(attachmentIds) ? attachmentIds.length : 0
  if (attachmentIdCount > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      status: 400,
      error: `too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`,
    }
  }

  // A message needs either text content OR at least one attachment. Empty
  // both means the client wired something wrong — but a bare
  // attachments-only send is a legitimate flow (drop an image, hit Enter).
  const hasAttachments = attachmentIdCount > 0
  if (content.trim().length === 0 && !hasAttachments) {
    return { ok: false, status: 400, error: "content or attachments required" }
  }

  // Idempotency pre-check (mutation-idempotency plan): a resend carrying a
  // nonce this author already committed must NOT claim a new seq or re-fire WS
  // fan-out. Look it up BEFORE the seq claim and short-circuit with the
  // original row. Absent nonce = today's behavior (no lookup at all). The
  // race where two concurrent first-sends both pass this check is caught at
  // insert time by the partial-unique-index handler below.
  if (clientNonce !== undefined) {
    const replay = await getCommunityMessageReplay({ db, authorId, channelId: target.channelId, clientNonce })
    if (replay) return replay
  }

  // A client-supplied `replyToId` must reference a message IN THE TARGET
  // channel. Validate on the WRITE path (not just the preview path below at
  // ~:520, which only *skips the preview* for an out-of-scope id while still
  // persisting the dangling reference). Without this, any client — web, CLI,
  // or bot (#204, bots ride the same send codepath as users) — could POST a
  // cross-scope `replyToId`; it would insert, then render as an unresolvable
  // "unknown" reply because `getMessageInScope` can't resolve it. We drop the
  // out-of-scope id (store as a plain message) rather than 400 — lenient,
  // matching the send path's "never fail the send on an edge case" posture —
  // and warn-log it as a likely client bug. `getMessageInScope` is scoped
  // `WHERE id = ? AND channelId = ?`, so a private source channel the author
  // can't otherwise see is denied here too (no leak of its content/existence).
  const rawReplyToId =
    typeof body.replyToId === "string" ? body.replyToId : undefined
  let replyToId = rawReplyToId
  // Resolved reply target, in-scope — carried to the preview block below so it
  // reuses this lookup instead of re-fetching (net: no extra query for the
  // common in-scope reply; the validation replaces the preview's fetch).
  let resolvedReplyMsg:
    | Awaited<ReturnType<typeof queries.communityMessage.getMessageInScope>>
    | null = null
  if (rawReplyToId !== undefined) {
    resolvedReplyMsg = await withD1Retry(
      () => queries.communityMessage.getMessageInScope(db, rawReplyToId, { channelId: target.channelId }),
      { route: "message-handler:reply-scope" },
    )
    if (!resolvedReplyMsg) {
      log.warn("reply_to_out_of_scope_dropped", {
        authorId,
        channelId: target.channelId,
        replyToId: rawReplyToId,
        source: source ?? "web",
      })
      replyToId = undefined
    }
  }
  const mentionType: MentionType | undefined =
    !isDmTarget(target) && isMentionType(body.mentionType)
      ? body.mentionType
      : undefined

  // Reply target for mention broadcasts. Scoped at the query level (not a
  // post-hoc `.filter()`) so a caller can't attach a preview of a message
  // from a different DM/channel by passing its id. The payload-side reply
  // preview is rebuilt from this same persisted relation by the dispatcher.
  const replyTargets = new Set<string>()
  // Reuse the in-scope reply target resolved at the write-validation step above
  // (`resolvedReplyMsg`) — it was fetched with the identical `getMessageInScope`
  // scope, so re-querying here would be redundant. `replyToId` is already
  // null when the id was out-of-scope (dropped above), so this block only runs
  // for a genuinely in-scope reply.
  if (!skipMentions && replyToId && resolvedReplyMsg) {
    // single-id path — see `dm/[id]/messages/route.ts` / `channels/[id]/messages/route.ts` for the batched N-id path
    if (resolvedReplyMsg.authorId && resolvedReplyMsg.authorId !== authorId) {
      replyTargets.add(resolvedReplyMsg.authorId)
    }
  }

  // Mention extraction is channel/thread only — DMs have no member roster
  // and no @-anyone semantics.
  //
  // Candidate scoping: a message can only mention/notify users in the unit's
  // OWN audience. For a private channel/post/thread that's the (climb-based)
  // audience — a channel/post can only mention its own members; a thread climbs
  // to its parent channel's audience. `@everyone` and reply targets are
  // likewise clamped to that audience. There is NO invite-by-mention at the
  // channel level (roster changes only via owner-add). Public/uncategorized
  // channels are unchanged (whole-server candidates).
  const mentionTargets = new Set<string>()
  // Subset of `mentionTargets` that came from an EXPLICIT `@user` (not a mass
  // `@everyone`). Only explicit mentions enroll someone as a permanent
  // thread participant — a broadcast `@everyone` notifies once but must not
  // subscribe the whole channel/server to every future reply (that would defeat
  // the notification dimension). See the thread-participation block below.
  const explicitMentionTargets = new Set<string>()
  if (!skipMentions && !isDmTarget(target)) {
    // Resolve the audience up front when private; `null` = public (no clamp).
    // PERF (accepted): `isChannelPrivate` and `getPrivateChannelAudienceUserIds`
    // each climb `parentChannelId` for a thread — two parent lookups per message
    // on the send path. Cheap (indexed id lookups) and not merged to keep both
    // helpers single-purpose; revisit only if the send path shows up hot.
    const isPrivate = await withD1Retry(
      () => queries.communityChannel.isChannelPrivate(db, target.channelId),
      { route: "message-handler:is-private" },
    )
    const audienceIds = isPrivate
      ? new Set(
          await withD1Retry(
            () => queries.communityChannel.getPrivateChannelAudienceUserIds(db, target.channelId),
            { route: "message-handler:private-audience" },
          ),
        )
      : null

    const hasAtMention = typeof content === "string" && content.includes("@")
    if (hasAtMention) {
      const allMembers = await withD1Retry(
        () => queries.communityMember.listMembers(db, target.serverId),
        { route: "message-handler:list-members" },
      )
      // Scope candidates to the audience when private.
      const members = audienceIds
        ? allMembers.filter((m) => audienceIds.has(m.userId))
        : allMembers
      if (mentionType === "everyone") {
        for (const m of members) {
          if (m.userId !== authorId) mentionTargets.add(m.userId)
        }
      }
      if (content) {
        const candidates = members
          .filter((m) => m.userId !== authorId && m.userName)
          .map((m) => ({ userId: m.userId, name: m.userName as string, discriminator: m.discriminator }))
        for (const id of extractMentionedUserIds(content, candidates)) {
          mentionTargets.add(id)
          explicitMentionTargets.add(id)
        }
      }
    } else if (mentionType === "everyone") {
      const userIds = audienceIds
        ? [...audienceIds]
        : await withD1Retry(
            () => queries.communityMember.listMemberUserIds(db, target.serverId),
            { route: "message-handler:list-member-ids" },
          )
      for (const uid of userIds) {
        if (uid !== authorId) mentionTargets.add(uid)
      }
    }

    // Reply targets outside the private audience are dropped (a former member
    // whose message is being replied to shouldn't get a notification for a
    // channel they can no longer see).
    if (audienceIds) {
      for (const id of [...replyTargets]) if (!audienceIds.has(id)) replyTargets.delete(id)
    }
  }

  // Snapshot the (audience-filtered) reply targets for thread enrollment BEFORE
  // the mention-row dedup below strips them. A direct reply always enrolls the
  // replied-to user as a participant — even when a co-occurring `@everyone`
  // also caught them (in which case they'd otherwise vanish from `replyTargets`
  // AND be absent from `explicitMentionTargets`).
  const replyParticipants = new Set(replyTargets)

  // Mention beats reply — never double-count the same user.
  for (const id of mentionTargets) replyTargets.delete(id)

  // Thread participation (notification dimension). A thread's NOTIFY set is
  // its participant rows — join by:
  //   - speaking: the author becomes a participant (source "spoke").
  //   - @mention: an explicitly mentioned/replied audience member becomes a
  //     participant (source "mention"). `mentionTargets`/`replyTargets` are
  //     already scoped to the unit's audience by the block above.
  // Admins are NOT auto-added — only real participation joins the set. System /
  // card messages (`skipMentions`) don't add the author.
  // Enroll gate = the REACH axis (B2): a message enrolls participants iff its
  // channel's reach is `participant-set`. This is the WRITE side of red-line ③ —
  // it keys on the SAME reach value that the fan-out recipient set and the
  // agent-inbox deliverable narrowing (the READ side, who's-participant) key on,
  // so who-enrolls and who's-read can never drift (the class of bug the agent
  // thread-inbox deadlock was). `target.kind` is the channel's stored type here
  // (channel/thread/forum/dm). NOT folded with parent-channel delivery: that
  // is a distinct STRUCTURAL fact ("has a parent channel" → railChannelId /
  // parent CHILD_CHANNEL_UPDATE tick), which merely coincides with participant-set
  // for today's types — a future type could have a parent but server reach, or
  // participant reach without a parent, so the two rules stay separate.
  let participants: { userId: string; source: string }[] = []
  if (reachIsParticipantSet(target.kind) && !skipMentions) {
    const rows: { userId: string; source: typeof PARTICIPANT_SOURCE.SPOKE | typeof PARTICIPANT_SOURCE.MENTION }[] = [
      { userId: authorId, source: PARTICIPANT_SOURCE.SPOKE },
    ]
    // Only EXPLICIT `@user` mentions + reply targets enroll as participants. A
    // mass `@everyone` is in `mentionTargets` (so everyone is notified
    // once) but NOT in `explicitMentionTargets`, so it doesn't permanently
    // subscribe the whole channel/server to the thread. `replyParticipants` is
    // the pre-dedup snapshot so a reply still enrolls even under `@everyone`.
    for (const id of new Set([...explicitMentionTargets, ...replyParticipants])) {
      if (id !== authorId) rows.push({ userId: id, source: PARTICIPANT_SOURCE.MENTION })
    }
    // One bulk insert (author + mentioned) instead of N+1 sequential inserts.
    participants = rows
  }

  const baseMessageData: Omit<Parameters<typeof queries.communityMessage.createMessage>[1], "expectedSeq"> = {
    authorId,
    authorKind,
    content,
    channelId: target.channelId,
    replyToId,
    mentionType,
    type: messageType,
    clientNonce,
    extraStatements,
    attachmentIds,
    participants,
    mentions: [
      ...[...mentionTargets].map((userId) => ({ userId, kind: MENTION_KIND.MENTION })),
      ...[...replyTargets].map((userId) => ({ userId, kind: MENTION_KIND.REPLY })),
    ],
    forumThread: params.forumThread,
  }

  let created: Awaited<ReturnType<typeof queries.communityMessage.createMessage>>
  try {
    created =
      expectedSeq !== undefined
        ? await queries.communityMessage.createMessage(db, { ...baseMessageData, expectedSeq })
        : await queries.communityMessage.createMessage(db, baseMessageData)
  } catch (err) {
    const attachmentConflict = queries.communityMessage.isMessageAttachmentConflict(err)
    if (clientNonce !== undefined && (attachmentConflict || isUniqueConstraintError(err))) {
      const replay = await getCommunityMessageReplay({ db, authorId, channelId: target.channelId, clientNonce })
      if (replay) return replay
    }
    if (attachmentConflict) {
      return { ok: false, status: 400, error: "attachment not found or not attachable to this target" }
    }
    throw err
  }

  if (created === null) {
    const replay = await getCommunityMessageReplay({ db, authorId, channelId: target.channelId, clientNonce })
    if (replay) return replay
    return { ok: false, status: 409, error: "seq_conflict" }
  }

  const joinedParticipantUserIds = created.joinedParticipantUserIds ?? []

  // Delivery is planned from committed D1 facts. The handler contributes only
  // structural outcomes that cannot be safely reconstructed later.
  const readStateRevision = (created as typeof created & {
    readStateRevision?: number
  }).readStateRevision
  const doBroadcast = async (): Promise<void> => {
    const deliveries: Promise<void>[] = [dispatchCommittedMessage(db, created.id, {
      ...(joinedParticipantUserIds.includes(authorId)
        ? { memberAddedUserId: authorId }
        : {}),
      ...(skipChildChannelUpdate ? { suppressParentProjection: true } : {}),
    })]
    if (readStateRevision !== undefined) {
      deliveries.push(broadcastToUserSafe(authorId, {
        type: WS_EVENTS.READ_STATE_ADVANCED,
        revision: readStateRevision,
        inboxChanged: true,
      }))
    }
    if (created.createdThread && !params.suppressThreadFanout) {
      deliveries.push(fanOutToChannel(target.channelId, {
        type: WS_EVENTS.CHILD_CHANNEL_CREATE,
        parentChannelId: target.channelId,
        parentMessageId: created.id,
        channel: { ...created.createdThread, type: "thread", creatorId: authorId },
      }))
    }
    await Promise.all(deliveries)
  }

  if (!suppressBroadcast && !deferBroadcast) {
    void doBroadcast().catch((error) => {
      log.warn("post_commit_notification_failed", { messageId: created.id, error: String(error) })
    })
  }

  const attachments = attachmentIds?.length
    ? await hydrateStoredAttachments(db, created.id)
    : []

  const row = await withD1Retry(
    () => queries.communityMessage.getMessage(db, created.id),
    { route: "message-handler:read-back" },
  )
  if (!row) {
    // createMessage just inserted this row; getMessage returning null means
    // the DB is gone — surface that to the caller instead of inventing data.
    throw new Error("message not found after insert")
  }

  if (!suppressBroadcast && deferBroadcast) {
    return { ok: true, row, attachments, broadcast: doBroadcast }
  }
  return { ok: true, row, attachments }
}
