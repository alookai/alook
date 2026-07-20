import {
  queries,
  extractMentionedUserIds,
  isMentionType,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  WS_EVENTS,
  createLogger,
} from "@alook/shared"
import type { MentionType } from "@alook/shared"
import type { Database } from "@alook/shared"
import { fanOutToChannel, fanOutToDM } from "./fanout"
import { broadcastToUser } from "../broadcast"
import { mapMessageForWs } from "./message-payload"
import { mediaUrlFromKey } from "./storage"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "./audit"

const log = createLogger({ service: "community-message-handler" })

export type MessageTarget =
  | { kind: "channel"; channelId: string; serverId: string }
  | {
    kind: "thread"
    channelId: string
    parentChannelId: string
    serverId: string
  }
  | {
    kind: "forum_post"
    channelId: string
    parentChannelId: string
    serverId: string
  }
  | { kind: "dm"; dmId: string; otherUserId: string }

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

// A thread and a forum_post share the same notify + parent-tick behavior: both
// enroll participants (spoke/mention) and both fire the parent CHILD_CHANNEL_UPDATE
// via their `parentChannelId`. This narrows to the two variants that carry one.
function hasParentChannel(
  target: MessageTarget,
): target is Extract<MessageTarget, { kind: "thread" | "forum_post" }> {
  return target.kind === "thread" || target.kind === "forum_post"
}

type IncomingAttachment = {
  /**
   * Full routable URL as returned by the human upload response
   * (`/api/community/media/<key>`). The handler strips the `MEDIA_URL_PREFIX`
   * to derive the stored `r2Key`. Kept on the wire (rather than switching
   * clients to a raw key) so the human-composer POST shape stays unchanged.
   */
  url: string
  filename: string
  contentType: string
  size: number
  width?: number
  height?: number
}

const MEDIA_URL_PREFIX = "/api/community/media/"

function r2KeyFromUrl(url: string): string | null {
  if (!url.startsWith(MEDIA_URL_PREFIX)) return null
  const rest = url.slice(MEDIA_URL_PREFIX.length)
  return rest.length > 0 ? rest : null
}

export type IncomingMessageBody = {
  content?: unknown
  replyToId?: unknown
  mentionType?: unknown
  attachments?: unknown
}

type CreatedAttachment = {
  id: string
  filename: string
  url: string
  contentType: string | null
  size: number | null
  width?: number | null
  height?: number | null
}

function attachmentKindFromTarget(target: MessageTarget): "channel" | "dm" {
  return target.kind === "dm" ? "dm" : "channel"
}

function attachmentTargetId(target: MessageTarget): string {
  return target.kind === "dm" ? target.dmId : target.channelId
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
   * fires the WS side effects (MENTION_CREATE, MESSAGE_CREATE fan-out, DM peer
   * ping / CHILD_CHANNEL_UPDATE, bot-wake enqueue) that `createCommunityMessage`
   * would otherwise have run inline. The DM-card producers deliberately never
   * invoke this — they persist their approval-request row first and fire their
   * own minimal `DM_NEW_MESSAGE` after it commits (see plan §producer).
   */
  broadcast?: () => Promise<void>
}

export type CreateMessageResult = CreateMessageOk | CreateMessageError

/**
 * Unified message-create pipeline for channel, thread, and DM POSTs.
 *
 * Handles request-body validation, message + attachment inserts, reply
 * resolution, mention extraction (channel/thread only — DMs only flag the
 * reply target), mention/reply broadcast, channel-or-DM fan-out, and the
 * parent-channel CHILD_CHANNEL_UPDATE that follows a thread reply.
 *
 * Each route resolves permission/target first, then delegates here.
 */
export async function createCommunityMessage(params: {
  db: Database
  authorId: string
  target: MessageTarget
  body: IncomingMessageBody
  /** Provenance tag threaded into the bot-authored audit row's `changes` (plan §10). */
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
   * Skip the bot-wake enqueue that rides the `MESSAGE_CREATE` fan-out. System
   * / card messages set this — they must not wake bots.
   */
  skipWake?: boolean
  /**
   * Fan out `MESSAGE_CREATE` WITHOUT `excludeUserId`, so the author also
   * receives the event. The thread_created system message needs this — its
   * creator has no optimistic client row and must get the WS broadcast to see
   * it without a refresh.
   */
  includeAuthorInFanout?: boolean
  /**
   * Agent-attachment path: pending attachment ids the caller has already
   * validated against (uploader, kind, target). When present, the handler
   * pre-mints the message id, reserves the pending rows in a single
   * atomic UPDATE, then inserts the message — compensating unreserves on
   * every failure path so no message row is ever committed with a partial
   * attachment set. Mutually exclusive with `body.attachments`, which is the
   * human-composer path.
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
}): Promise<CreateMessageResult> {
  const {
    db,
    authorId,
    target,
    body,
    source,
    expectedSeq,
    messageType,
    skipMentions,
    skipWake,
    includeAuthorInFanout,
    deferBroadcast,
    attachmentIds,
  } = params

  const content = typeof body.content === "string" ? body.content : ""
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
    }
  }

  const incomingAttachments = Array.isArray(body.attachments)
    ? (body.attachments as IncomingAttachment[])
    : undefined
  if (
    incomingAttachments &&
    incomingAttachments.length > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    return {
      ok: false,
      status: 400,
      error: `too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`,
    }
  }

  // A message needs either text content OR at least one attachment. Empty
  // both means the client wired something wrong — but a bare
  // attachments-only send is a legitimate flow (drop an image, hit Enter).
  // Agent-attachment path uses `attachmentIds` (pending rows reserved by
  // reservation-first flow), NOT `body.attachments`; both count as
  // "attachment present" for this guard.
  const hasAgentAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0
  const hasHumanAttachments = !!incomingAttachments && incomingAttachments.length > 0
  if (content.trim().length === 0 && !hasHumanAttachments && !hasAgentAttachments) {
    return { ok: false, status: 400, error: "content or attachments required" }
  }

  const replyToId =
    typeof body.replyToId === "string" ? body.replyToId : undefined
  const mentionType: MentionType | undefined =
    !isDmTarget(target) && isMentionType(body.mentionType)
      ? body.mentionType
      : undefined

  const baseMessageData: {
    authorId: string;
    content: string;
    channelId: string | undefined;
    dmConversationId: string | undefined;
    replyToId: string | undefined;
    mentionType: MentionType | undefined;
    type?: string;
  } = {
    authorId,
    content,
    channelId: isDmTarget(target) ? undefined : target.channelId,
    dmConversationId: isDmTarget(target) ? target.dmId : undefined,
    replyToId,
    mentionType,
    ...(messageType !== undefined ? { type: messageType } : {}),
  }

  // Insert first so `reserveAttachmentsForMessage`'s UPDATE can key off
  // `created.id` (the FK enforces the message row exists); compensate with
  // the cascading `hardDeleteMessage` on reserve failure or partial reserve.
  // See plans/attachment-pipeline-empty-body-guardrails.md Layer 5-6 for the
  // rollback contract.
  //
  // Narrow once here so downstream branches don't need `attachmentIds!`.
  const reserveIds: string[] | null =
    attachmentIds !== undefined && attachmentIds.length > 0 ? attachmentIds : null

  // `createMessage`'s overloads key off whether the `expectedSeq` property
  // is present at all, not just its runtime value — a `number | undefined`
  // typed property doesn't cleanly resolve against either overload, so the
  // pass-through branches explicitly instead of spreading `expectedSeq` in.
  const created: Awaited<ReturnType<typeof queries.communityMessage.createMessage>> =
    expectedSeq !== undefined
      ? await queries.communityMessage.createMessage(db, { ...baseMessageData, expectedSeq })
      : await queries.communityMessage.createMessage(db, baseMessageData)

  // Lost the CAS race (plans/fix-agent-send-race-condition.md) — zero rows
  // were written anywhere (no message, no channel/DM bump, no read-state
  // watermark). No attachments were reserved yet, so nothing to unreserve.
  if (created === null) {
    return { ok: false, status: 409, error: "seq_conflict" }
  }

  if (reserveIds) {
    let reserved: string[]
    try {
      reserved = await queries.communityAttachment.reserveAttachmentsForMessage(db, {
        ids: reserveIds,
        messageId: created.id,
      })
    } catch (err) {
      // Reserve threw (transient D1 / constraint / etc.). The message row
      // exists but has zero attachments reserved to it — hard-delete it so
      // the caller can retry with the same attachment ids. If the
      // compensating hardDelete ALSO throws (same D1 outage the reserve was
      // recovering from), log both and re-throw the ORIGINAL reserve error —
      // it's the one the caller cares about; matches bots/route.ts:139's shape.
      try {
        await queries.communityMessage.hardDeleteMessage(db, created.id)
      } catch (rollbackErr) {
        log.error("attachment_reserve_rollback_failed", {
          messageId: created.id,
          insertErr: err instanceof Error ? err.message : String(err),
          rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        })
      }
      throw err
    }
    if (reserved.length !== reserveIds.length) {
      // Partial-overlap race (S1={A,B}, S2={B,C}) or an id that no longer
      // matches (uploader/kind/target/messageId-null). Compensate:
      // unreserve whatever THIS caller uniquely grabbed AND hard-delete the
      // orphan message row. Both compensating writes are individually guarded:
      // if unreserve throws we still try the hardDelete (else we'd leave a
      // live message row alongside the stale partial-reserve); if either
      // throws we log but still return the 400 envelope — the caller-facing
      // shape doesn't depend on whether compensation succeeded.
      try {
        await queries.communityAttachment.unreserveAttachments(db, {
          ids: reserved,
          messageId: created.id,
        })
      } catch (unreserveErr) {
        log.error("attachment_partial_reserve_unreserve_failed", {
          messageId: created.id,
          unreserveErr: unreserveErr instanceof Error ? unreserveErr.message : String(unreserveErr),
        })
      }
      try {
        await queries.communityMessage.hardDeleteMessage(db, created.id)
      } catch (rollbackErr) {
        log.error("attachment_partial_reserve_rollback_failed", {
          messageId: created.id,
          rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        })
      }
      return {
        ok: false,
        status: 400,
        error: "attachment not found or not attachable to this target",
      }
    }
  }

  // Human-composer path: insert attachment rows now that the message exists.
  // Agent path: rows were already reserved and pointed at `created.id` via
  // the pre-minted id, so no additional INSERT is needed here.
  let attachments: CreatedAttachment[] = []
  if (reserveIds) {
    const rows = await queries.communityAttachment.listByMessageIds(db, [created.id])
    attachments = rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      url: mediaUrlFromKey(r.r2Key),
      contentType: r.contentType,
      size: r.size,
      width: r.width,
      height: r.height,
    }))
  } else if (incomingAttachments?.length) {
    const kind = attachmentKindFromTarget(target)
    const targetId = attachmentTargetId(target)
    attachments = await Promise.all(
      incomingAttachments.map(async (att, idx) => {
        const r2Key = r2KeyFromUrl(att.url)
        if (!r2Key) {
          throw new Error(`attachment url outside /api/community/media/: ${att.url}`)
        }
        const row = await queries.communityAttachment.createAttachment(db, {
          messageId: created.id,
          uploaderId: authorId,
          kind,
          targetId,
          r2Key,
          filename: att.filename,
          position: idx,
          contentType: att.contentType,
          size: att.size,
          width: att.width,
          height: att.height,
        })
        return {
          id: row.id,
          filename: row.filename,
          url: mediaUrlFromKey(row.r2Key),
          contentType: row.contentType,
          size: row.size,
          width: row.width,
          height: row.height,
        }
      }),
    )
  }

  const row = await queries.communityMessage.getMessage(db, created.id)
  if (!row) {
    // createMessage just inserted this row; getMessage returning null means
    // the DB is gone — surface that to the caller instead of inventing data.
    throw new Error("message not found after insert")
  }

  // Bot-authored audit (plan §10) — moved here from individual call sites
  // (the daemon bot-message route used to log this itself) so EVERY caller,
  // present and future (the CLI `send` route included), gets it for free
  // with no duplicate-call risk. There's no standalone `isBot()` helper in
  // the repo; this mirrors the check the daemon route did before its own
  // `logAudit` call was removed. Fire-and-forget — `logAudit` already
  // swallows its own errors.
  const author = await queries.user.getUserInternal(db, authorId)
  if (author?.isBot === true) {
    logAudit(db, {
      serverId: isDmTarget(target) ? null : target.serverId,
      actorId: authorId,
      action: COMMUNITY_AUDIT_ACTIONS.MESSAGE_AUTHORED_AS_BOT,
      targetType: "message",
      targetId: row.id,
      changes: JSON.stringify({
        botId: authorId,
        target: target.kind,
        targetId: isDmTarget(target) ? target.dmId : target.channelId,
        messageId: row.id,
        source: source ?? "web",
      }),
    })
  }

  // Reply target for mention broadcasts. Scoped at the query level (not a
  // post-hoc `.filter()`) so a caller can't attach a preview of a message
  // from a different DM/channel by passing its id. The payload-side reply
  // preview is built from the same scope-checked map by `mapMessageForWs`
  // below.
  const replyMap = new Map<string, { id: string; authorName: string; content: string | null }>()
  const replyTargets = new Set<string>()
  if (!skipMentions && row.replyToId) {
    // single-id path — see `dm/[id]/messages/route.ts` / `channels/[id]/messages/route.ts` for the batched N-id path
    const scope = isDmTarget(target) ? { dmConversationId: target.dmId } : { channelId: target.channelId }
    const replyMsg = await queries.communityMessage.getMessageInScope(db, row.replyToId, scope)
    if (replyMsg) {
      replyMap.set(replyMsg.id, {
        id: replyMsg.id,
        authorName: replyMsg.authorName,
        content: replyMsg.content,
      })
      if (replyMsg.authorId && replyMsg.authorId !== authorId) {
        replyTargets.add(replyMsg.authorId)
      }
    }
  }

  // Mention extraction is channel/thread only — DMs have no member roster
  // and no @-anyone semantics.
  //
  // Candidate scoping: a message can only mention/notify users in the unit's
  // OWN audience. For a private channel/post/thread that's the (climb-based)
  // audience — a channel/post can only mention its own members; a thread climbs
  // to its parent channel's audience. `@everyone`/`@here` and reply targets are
  // likewise clamped to that audience. There is NO invite-by-mention at the
  // channel level (roster changes only via owner-add). Public/uncategorized
  // channels are unchanged (whole-server candidates).
  const mentionTargets = new Set<string>()
  // Subset of `mentionTargets` that came from an EXPLICIT `@user` (not a mass
  // `@everyone`/`@here`). Only explicit mentions enroll someone as a permanent
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
    const isPrivate = await queries.communityChannel.isChannelPrivate(db, target.channelId)
    const audienceIds = isPrivate
      ? new Set(await queries.communityChannel.getPrivateChannelAudienceUserIds(db, target.channelId))
      : null

    const hasAtMention = typeof row.content === "string" && row.content.includes("@")
    if (hasAtMention) {
      const allMembers = await queries.communityMember.listMembers(db, target.serverId)
      // Scope candidates to the audience when private.
      const members = audienceIds
        ? allMembers.filter((m) => audienceIds.has(m.userId))
        : allMembers
      if (mentionType === "everyone" || mentionType === "here") {
        for (const m of members) {
          if (m.userId !== authorId) mentionTargets.add(m.userId)
        }
      }
      if (row.content) {
        const candidates = members
          .filter((m) => m.userId !== authorId && m.userName)
          .map((m) => ({ userId: m.userId, name: m.userName as string, discriminator: m.discriminator }))
        for (const id of extractMentionedUserIds(row.content, candidates)) {
          mentionTargets.add(id)
          explicitMentionTargets.add(id)
        }
      }
    } else if (mentionType === "everyone" || mentionType === "here") {
      const userIds = audienceIds
        ? [...audienceIds]
        : await queries.communityMember.listMemberUserIds(db, target.serverId)
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

  // Thread / forum_post participation (notification dimension). Both units'
  // NOTIFY set is their participant rows — join by:
  //   - speaking: the author becomes a participant (source "spoke").
  //   - @mention: an explicitly mentioned/replied audience member becomes a
  //     participant (source "mention"). `mentionTargets`/`replyTargets` are
  //     already scoped to the unit's audience by the block above.
  // Admins are NOT auto-added — only real participation joins the set. System /
  // card messages (`skipMentions`) don't add the author. A forum post is
  // enrolled exactly like a thread so it notifies only its participants.
  if (hasParentChannel(target) && !skipMentions) {
    const rows: { userId: string; source: "spoke" | "mention" }[] = [
      { userId: authorId, source: "spoke" },
    ]
    // Only EXPLICIT `@user` mentions + reply targets enroll as participants. A
    // mass `@everyone`/`@here` is in `mentionTargets` (so everyone is notified
    // once) but NOT in `explicitMentionTargets`, so it doesn't permanently
    // subscribe the whole channel/server to the thread. `replyParticipants` is
    // the pre-dedup snapshot so a reply still enrolls even under `@everyone`.
    for (const id of new Set([...explicitMentionTargets, ...replyParticipants])) {
      if (id !== authorId) rows.push({ userId: id, source: "mention" })
    }
    // One bulk insert (author + mentioned) instead of N+1 sequential inserts.
    await queries.communityThread.addThreadParticipants(db, target.channelId, rows)
  }

  // Mention/reply ROW writes are persistence, not broadcast — they run inline
  // even under `deferBroadcast` (only the WS emissions defer). When
  // `skipMentions` both sets are empty, so these are no-ops.
  const liveMentions = [...mentionTargets]
  const liveReplies = [...replyTargets]
  if (liveMentions.length > 0) {
    await queries.communityMention.createMentions(db, {
      messageId: row.id,
      userIds: liveMentions,
      kind: "mention",
    })
  }
  if (liveReplies.length > 0) {
    await queries.communityMention.createMentions(db, {
      messageId: row.id,
      userIds: liveReplies,
      kind: "reply",
    })
  }

  const messagePayload = mapMessageForWs(row, {
    replyMap,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.contentType ?? undefined,
      size: a.size ?? undefined,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
    })),
  })

  // Wake-dispatch row (minimal-wake-queue-unread-notice plan §1/§5) — the
  // same `row` already fetched above via `getMessage` (which now selects
  // `seq`). Passed alongside the MESSAGE_CREATE event so
  // `fanOutToChannel`/`fanOutToDM` can enqueue bot wakes using the SAME
  // recipient list already resolved for the human-WS broadcast, no second
  // membership query. Deliberately no `content`/`createdAt` — the queue
  // payload only ever carries `{ messageId, botUserId }`. Suppressed when
  // `skipWake` (system/card messages never wake bots).
  const wakeMessageRow = skipWake
    ? undefined
    : {
      id: row.id,
      seq: row.seq,
      authorId: row.authorId,
      channelId: row.channelId,
      dmConversationId: row.dmConversationId,
    }

  // `includeAuthorInFanout` fans out MESSAGE_CREATE without `excludeUserId`
  // (thread_created: the creator has no optimistic row and needs the event).
  const fanoutExclude = includeAuthorInFanout ? undefined : authorId

  // All WS side effects live here so `deferBroadcast` can hand them back as a
  // thunk instead of firing them inline.
  const doBroadcast = async (): Promise<void> => {
    if (liveMentions.length > 0 || liveReplies.length > 0) {
      const authorName = row.authorName
      const channelIdForBroadcast =
        isDmTarget(target) ? undefined : target.channelId
      for (const userId of [...liveMentions, ...liveReplies]) {
        broadcastToUser(userId, {
          type: WS_EVENTS.MENTION_CREATE,
          userId,
          messageId: row.id,
          ...(channelIdForBroadcast ? { channelId: channelIdForBroadcast } : {}),
          authorName,
        }).catch(() => { })
      }
    }

    if (isDmTarget(target)) {
      fanOutToDM(
        target.dmId,
        {
          type: WS_EVENTS.MESSAGE_CREATE,
          dmConversationId: target.dmId,
          message: messagePayload,
        },
        { excludeUserId: fanoutExclude, wakeMessageRow },
      ).catch(() => { })

      broadcastToUser(target.otherUserId, {
        type: WS_EVENTS.DM_NEW_MESSAGE,
        dmConversationId: target.dmId,
        message: messagePayload,
      }).catch(() => { })
    } else {
      fanOutToChannel(
        target.channelId,
        {
          type: WS_EVENTS.MESSAGE_CREATE,
          channelId: target.channelId,
          message: messagePayload,
        },
        { excludeUserId: fanoutExclude, wakeMessageRow },
      ).catch(() => { })

      if (hasParentChannel(target)) {
        const updated = await queries.communityChannel.getChannel(
          db,
          target.channelId,
        )
        fanOutToChannel(
          target.parentChannelId,
          {
            type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
            parentChannelId: target.parentChannelId,
            channelId: target.channelId,
            changes: {
              messageCount: updated?.messageCount ?? 1,
              lastMessageAt:
                updated?.lastMessageAt ?? new Date().toISOString(),
            },
          },
          { excludeUserId: fanoutExclude },
        ).catch(() => { })
      }
    }
  }

  if (deferBroadcast) {
    return { ok: true, row, attachments, broadcast: doBroadcast }
  }
  await doBroadcast()
  return { ok: true, row, attachments }
}
