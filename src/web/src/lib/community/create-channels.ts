import {
  queries,
  canManageServer,
  isChannelType,
  channelCreation,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  slugify,
  PARTICIPANT_SOURCE,
  createLogger,
  type ChannelType,
  type StoredChannelType,
  type Database,
} from "@alook/shared"
import { fanOutToServerMembers, fanOutToChannel } from "@/lib/community/fanout"
import { createWithCollisionPolicy } from "@/lib/community/create-collision"
import { requireServerMember, requireChannelMember } from "@/lib/community/permissions"
import { requireMessageBearingSurface } from "@/lib/community/channel-write-guard"
import { guardDmOpen } from "@/lib/community/dm-guard"
import { createCommunityMessage, type IncomingMessageBody } from "@/lib/community/message-handler"
import { attachmentThumbnailUrl, attachmentUrl } from "@/lib/community/storage"

const log = createLogger({ service: "community-create-channels" })

/**
 * Single-source creation cores for the `POST /channels` create door (route/disc
 * trunk 接口树统一, create-door step). Each function is the exact body that used
 * to live inline in one legacy create entry — extracted so the door and the
 * (transitionally kept-alive) legacy route call ONE code path, making their
 * equivalence structural rather than a copy that can drift. The door dispatches
 * on the requested type's creation trait; these are the per-type attempt +
 * side-effect shapes those traits parameterize.
 *
 * Boundary (createWithCollisionPolicy doc): text/forum are reject-on-collision
 * (by-name), thread is get-or-create (by root-message anchor); DM is get-or-create
 * by user-pair IDENTITY — a different key space — so it stays on createOrGetDM and
 * is NOT wired through createWithCollisionPolicy (folding it would compress two
 * collision-key axes into one value = false convergence).
 */

export type CreateChannelResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string }

/**
 * Create a top-level text/forum channel under a server (reject-on-collision).
 * Byte-identical to the former servers/[id]/channels POST body.
 */
export async function createServerChannelForUser(
  db: Database,
  params: {
    serverId: string
    actorUserId: string
    name?: unknown
    type?: unknown
    categoryId?: unknown
    topic?: unknown
  },
): Promise<CreateChannelResult<{ id: string; name: string; type: ChannelType; categoryId: string | null; topic?: string; position: number; createdAt: number }>> {
  const { serverId, actorUserId } = params

  const auth = await requireServerMember(db, serverId, actorUserId)
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error }
  const member = auth.value!

  if (!params.name || typeof params.name !== "string") {
    return { ok: false, status: 400, error: "name is required" }
  }
  const trimmed = params.name.trim()
  if (!trimmed || trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
    return { ok: false, status: 400, error: `name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters` }
  }
  const name = slugify(trimmed)
  if (!name) {
    return { ok: false, status: 400, error: "name is required" }
  }
  if (params.type !== undefined && !isChannelType(params.type)) {
    return { ok: false, status: 400, error: "type must be 'text' or 'forum'" }
  }
  const type = params.type as ChannelType | undefined
  if (params.topic !== undefined) {
    if (typeof params.topic !== "string") return { ok: false, status: 400, error: "topic must be a string" }
    if (params.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return { ok: false, status: 400, error: `topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters` }
    }
  }
  const topic = params.topic as string | undefined
  const categoryId = typeof params.categoryId === "string" ? params.categoryId : undefined

  // Who may create depends on the target location:
  //   - uncategorized OR public category → admin/owner only
  //   - private category → any server member (they own the channel + its roster)
  const isAdmin = canManageServer(member.role)
  let isPrivateCategory = false
  if (categoryId) {
    const category = await queries.communityCategory.getCategory(db, categoryId)
    if (!category || category.serverId !== serverId) {
      return { ok: false, status: 404, error: "category not found" }
    }
    isPrivateCategory = !!category.private
  }
  if (!isPrivateCategory && !isAdmin) {
    return { ok: false, status: 403, error: "admin permission required" }
  }

  const effectiveType: StoredChannelType = type === "forum" ? "forum" : "text"
  const createResult = await createWithCollisionPolicy(channelCreation(effectiveType), {
    attempt: () => queries.communityChannel.createChannel(db, {
      serverId,
      categoryId: categoryId || null,
      name,
      type,
      topic,
      creatorId: actorUserId,
    }),
    onReject: () => ({ status: 409, error: "a channel with this name already exists" }),
  })
  if (!createResult.ok) return { ok: false, status: createResult.status, error: createResult.error }
  const row = createResult.value

  if (isPrivateCategory) {
    await queries.communityChannel.createChannelMember(db, {
      channelId: row.id,
      userId: actorUserId,
      addedBy: actorUserId,
    })
  }

  const channel = {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    categoryId: row.categoryId,
    topic: row.topic ?? undefined,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  }

  if (isPrivateCategory) {
    await fanOutToChannel(row.id, {
      type: WS_EVENTS.CHANNEL_CREATE,
      serverId,
      channel,
    })
  } else {
    await fanOutToServerMembers(serverId, {
      type: WS_EVENTS.CHANNEL_CREATE,
      serverId,
      channel,
    })
  }


  return { ok: true, value: channel }
}

/**
 * Create-or-get a DM channel for a user pair (get-or-create by peer identity).
 * Byte-identical to the former dm/route POST body.
 */
export async function createDmForUser(
  db: Database,
  params: { actorUserId: string; peerUserId?: unknown },
): Promise<CreateChannelResult<Awaited<ReturnType<typeof queries.communityDm.createOrGetDM>>>> {
  if (!params.peerUserId || typeof params.peerUserId !== "string") {
    return { ok: false, status: 400, error: "userId is required" }
  }

  // Default callerKind ("human") — 404-on-friend-failure preserved exactly.
  const guard = await guardDmOpen(db, params.actorUserId, params.peerUserId)
  if (!guard.ok) return { ok: false, status: guard.status, error: guard.error }

  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: params.actorUserId,
    userId2: params.peerUserId,
  })

  return { ok: true, value: dm }
}

/**
 * Create-or-get a thread rooted on a top-level channel message (get-or-create by
 * the root message anchor). Folds the former messages/[id]/threads POST body but
 * unifies its behavior with the send-path thread create: the legacy route
 * hand-rolled a 409 "already has a thread" pre-check; that 409 was never a
 * consumed signal (no caller branched on it — Ingaborg #472), so the trait's
 * get-or-create (return the existing thread) is strictly more useful. One thread
 * semantics now, shared with resolve-ref's createThreadIfMissing.
 */
export async function createThreadForUser(
  db: Database,
  params: { messageId: string; actorUserId: string; name?: unknown },
): Promise<CreateChannelResult<Awaited<ReturnType<typeof queries.communityChannel.createChannel>>>> {
  const { messageId, actorUserId } = params

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return { ok: false, status: 404, error: "message not found" }
  if (!message.channelId) return { ok: false, status: 400, error: "message is not in a channel" }

  const auth = await requireChannelMember(db, message.channelId, actorUserId)
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error }
  const channel = auth.value

  // Threads may only root on a TOP-LEVEL channel's message (privacy anchor climb
  // can't resolve a grandchild). The UI already forbids this; enforce on the API.
  if (channel.parentChannelId) {
    return { ok: false, status: 400, error: "can't start a thread on a message in a thread or forum post" }
  }

  // A thread roots on a real message → the anchor's channel must be message-bearing
  // (a `forum` top-level is a post index, not a message surface).
  const bearing = requireMessageBearingSurface(channel.type)
  if (!bearing.ok) return { ok: false, status: bearing.status, error: bearing.error }

  if (!params.name || typeof params.name !== "string") return { ok: false, status: 400, error: "name is required" }
  const name = params.name.trim()
  if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
    return { ok: false, status: 400, error: `name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters` }
  }

  // Get-or-create by the root-message anchor, matching the send-path exactly
  // (resolve-ref createThreadIfMissing) — ONE thread semantics on BOTH axes,
  // result AND side effects. Probe for the existing thread first and early-return
  // it with ZERO seed/fan-out (Ingaborg #478): the participant seed + the
  // CHILD_CHANNEL_CREATE broadcast are FRESH-CREATE side effects. Running them on
  // a re-select would emit a spurious "new child channel" broadcast every time a
  // message that already has a thread is re-created (the former 409 route errored
  // before any side effect; the send-path early-returns). The createWithCollisionPolicy
  // below still guards the concurrent-create race (two creators past this probe
  // at once → the loser hits the unique index → refetchWinner), and that rare
  // re-select is side-effect-free for the same reason.
  const existingThread = await queries.communityChannel.getThreadChannelByParentMessage(db, message.channelId, messageId)
  if (existingThread) return { ok: true, value: existingThread }

  const threadResult = await createWithCollisionPolicy(channelCreation("thread"), {
    attempt: () => queries.communityChannel.createChannel(db, {
      serverId: channel.serverId,
      parentChannelId: message.channelId!,
      parentMessageId: messageId,
      name,
      type: "thread",
      creatorId: actorUserId,
    }),
    refetchWinner: () => queries.communityChannel.getThreadChannelByParentMessage(db, message.channelId!, messageId),
  })
  // get-or-create never returns a structured failure — a !ok is unreachable for
  // this policy (it creates or re-selects, else throws); map to 404 defensively.
  if (!threadResult.ok) return { ok: false, status: 404, error: "thread not found" }
  const childChannel = threadResult.value
  // Fresh-create vs concurrent-race re-select (rare — both creators passed the
  // probe above before either inserted, so the loser's attempt() threw and
  // refetchWinner returned the OTHER creator's row). Only the winner whose row
  // this actor created (creatorId === actorUserId) is a fresh create; a
  // re-selected row was created by someone else who already ran these side
  // effects. Keeps re-select side-effect-free on the race path too.
  const isFreshCreate = childChannel.creatorId === actorUserId

  // Seed the NOTIFY set on a fresh create only: creator (spoke) + original author
  // (added, if still a member — else a private channel's thread could leak to
  // someone who lost access). Idempotent per (channel,user) via onConflictDoNothing.
  if (isFreshCreate) {
    const seedRows: { userId: string; source: typeof PARTICIPANT_SOURCE.SPOKE | typeof PARTICIPANT_SOURCE.ADDED }[] = [
      { userId: actorUserId, source: PARTICIPANT_SOURCE.SPOKE },
    ]
    if (message.authorId !== actorUserId) {
      const authorStillMember = await requireChannelMember(db, message.channelId, message.authorId)
      if (authorStillMember.ok) seedRows.push({ userId: message.authorId, source: PARTICIPANT_SOURCE.ADDED })
    }
    await queries.communityThread.addThreadParticipants(db, childChannel.id, seedRows)

    fanOutToChannel(message.channelId, {
      type: WS_EVENTS.CHILD_CHANNEL_CREATE,
      parentChannelId: message.channelId,
      channel: {
        id: childChannel.id,
        name: childChannel.name,
        type: "thread" as const,
        creatorId: actorUserId,
        createdAt: childChannel.createdAt,
      },
      parentMessageId: messageId,
    }, { excludeUserId: actorUserId })
  }

  return { ok: true, value: childChannel }
}

type CreateMessageSuccess = Extract<Awaited<ReturnType<typeof createCommunityMessage>>, { ok: true }>

export type CreateMessageWithThreadResult =
  | {
    ok: true
    message: CreateMessageSuccess["row"]
    attachments: CreateMessageSuccess["attachments"]
    thread: Awaited<ReturnType<typeof queries.communityChannel.createChannel>>
    deduped?: boolean
  }
  | { ok: false; status: number; error: string }

export async function createMessageWithThread(params: {
  db: Database
  authorId: string
  parentChannelId: string
  serverId: string
  body: IncomingMessageBody
  threadName?: string
  suppressBroadcast?: boolean
  suppressThreadFanout?: boolean
  attachmentIds?: string[]
  pendingAttachmentIdsToRebind?: string[]
  clientNonce?: string
  source?: "cli" | "daemon-http" | "web"
}): Promise<CreateMessageWithThreadResult> {
  const { db, authorId, parentChannelId, serverId } = params

  const created = await createCommunityMessage({
    db,
    authorId,
    target: { kind: "channel", channelId: parentChannelId, serverId },
    body: params.body,
    source: params.source,
    attachmentIds: params.attachmentIds,
    clientNonce: params.clientNonce,
    suppressBroadcast: params.suppressBroadcast,
    deferBroadcast: true,
  })
  if (!created.ok) return { ok: false, status: created.status, error: created.error }
  const messageId = created.row.id

  if (created.deduped) {
    const thread = await queries.communityChannel.getThreadChannelByParentMessage(
      db,
      parentChannelId,
      messageId,
    )
    if (!thread) throw new Error("deduped forum opener is missing its thread")
    // Structure replay is already complete. Do not touch attachment rows here:
    // they may be pending on this thread (reply previously failed) or already
    // bound to the deduped reply (whole command previously succeeded).
    const storedAttachments = await queries.communityAttachment.listMessageAttachments(db, messageId)
    const toCreatedAttachment = (row: (typeof storedAttachments)[number]) => ({
      id: row.id,
      filename: row.filename,
      url: attachmentUrl(row.targetId, row.id),
      ...(row.thumbnailR2Key ? { thumbnailUrl: attachmentThumbnailUrl(row.targetId, row.id) } : {}),
      contentType: row.contentType,
      size: row.size,
      width: row.width,
      height: row.height,
    })
    return {
      ok: true,
      message: created.row,
      attachments: storedAttachments.map(toCreatedAttachment),
      thread,
      deduped: true,
    }
  }

  // Always truncated to MAX_CHANNEL_NAME_LENGTH — the thread's `name` column
  // is a channel-naming field (display-only, but still bounded like every
  // other channel name), regardless of how long the caller-supplied
  // threadName or the opener's own content happens to be (e.g. a post's
  // title can be up to MAX_MESSAGE_CONTENT_LENGTH — do not let that length
  // leak into this field uncapped).
  const threadName = (params.threadName?.trim() || created.row.content?.trim() || "thread").slice(0, MAX_CHANNEL_NAME_LENGTH)

  let threadResult: Awaited<ReturnType<typeof createWithCollisionPolicy<Awaited<ReturnType<typeof queries.communityChannel.createChannel>>>>>
  try {
    threadResult = await createWithCollisionPolicy(channelCreation("thread"), {
      attempt: () => queries.communityChannel.createChannel(db, {
        serverId,
        parentChannelId,
        parentMessageId: messageId,
        name: threadName,
        type: "thread",
        creatorId: authorId,
      }),
      refetchWinner: () => queries.communityChannel.getThreadChannelByParentMessage(db, parentChannelId, messageId),
    })
  } catch (err) {
    // Compensate: the message was inserted but its thread never opened — no
    // caller may see a message that's supposed to have a thread but doesn't.
    // If the compensating hardDelete ALSO throws (same D1 outage the
    // thread-open was recovering from), log BOTH and re-throw the ORIGINAL
    // thread-open error — it's the one the caller cares about; matches
    // message-handler.ts's attachment-reserve rollback shape exactly (never
    // let a secondary rollback failure mask the real cause, and never fail
    // silently — Aigneis #670/#680).
    try {
      await queries.communityMessage.hardDeleteMessage(db, messageId)
    } catch (rollbackErr) {
      log.error("thread_open_rollback_failed", {
        messageId,
        threadOpenErr: err instanceof Error ? err.message : String(err),
        rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      })
    }
    throw err
  }
  if (!threadResult.ok) {
    try {
      await queries.communityMessage.hardDeleteMessage(db, messageId)
    } catch (rollbackErr) {
      log.error("thread_open_rollback_failed", {
        messageId,
        threadOpenErr: threadResult.error,
        rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      })
    }
    return { ok: false, status: 404, error: "thread not found" }
  }
  const childChannel = threadResult.value
  const isFreshCreate = childChannel.creatorId === authorId

  const compensateFreshStructure = async (cause: unknown) => {
    if (isFreshCreate) {
      try {
        await queries.communityChannel.deleteChannel(db, childChannel.id)
      } catch (rollbackErr) {
        log.error("thread_rollback_delete_channel_failed", {
          messageId,
          cause: cause instanceof Error ? cause.message : String(cause),
          rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        })
      }
      try {
        await queries.communityMessage.hardDeleteMessage(db, messageId)
      } catch (rollbackErr) {
        log.error("thread_rollback_delete_opener_failed", {
          messageId,
          cause: cause instanceof Error ? cause.message : String(cause),
          rollbackErr: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        })
      }
    }
  }

  if (isFreshCreate) {
    try {
      await queries.communityThread.addThreadParticipants(db, childChannel.id, [
        { userId: authorId, source: PARTICIPANT_SOURCE.SPOKE },
      ])
    } catch (err) {
      await compensateFreshStructure(err)
      throw err
    }
  }

  let rebound: boolean
  try {
    rebound = await queries.communityAttachment.rebindPendingAttachmentsToChild(db, {
      ids: params.pendingAttachmentIdsToRebind ?? [],
      uploaderId: authorId,
      parentTargetId: parentChannelId,
      childTargetId: childChannel.id,
    })
  } catch (err) {
    await compensateFreshStructure(err)
    throw err
  }
  if (!rebound) {
    await compensateFreshStructure("attachment rebind rejected")
    return { ok: false, status: 400, error: "attachment not found or not attachable to this thread" }
  }

  if (isFreshCreate) {
    await created.broadcast?.()

    if (!params.suppressThreadFanout) {
      await fanOutToChannel(parentChannelId, {
        type: WS_EVENTS.CHILD_CHANNEL_CREATE,
        parentChannelId,
        channel: {
          id: childChannel.id,
          name: childChannel.name,
          type: "thread" as const,
          creatorId: authorId,
          createdAt: childChannel.createdAt,
        },
        parentMessageId: messageId,
      }, { excludeUserId: authorId })
    }
  }

  return { ok: true, message: created.row, attachments: created.attachments, thread: childChannel }
}
