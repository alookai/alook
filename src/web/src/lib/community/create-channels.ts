import {
  queries,
  canManageServer,
  isChannelType,
  channelCreation,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  slugify,
  PARTICIPANT_SOURCE,
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
import { nanoid } from "nanoid"

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

  let name: string
  if (params.name === undefined) {
    const source = message.content?.trim() ?? ""
    name = source ? source.slice(0, 40) : "Thread"
  } else {
    if (typeof params.name !== "string") return { ok: false, status: 400, error: "name is required" }
    name = params.name.trim()
    if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
      return { ok: false, status: 400, error: `name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters` }
    }
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

  const seedRows: { userId: string; source: typeof PARTICIPANT_SOURCE.SPOKE | typeof PARTICIPANT_SOURCE.ADDED }[] = [
    { userId: actorUserId, source: PARTICIPANT_SOURCE.SPOKE },
  ]
  if (message.authorId !== actorUserId) {
    const authorStillMember = await requireChannelMember(db, message.channelId, message.authorId)
    if (authorStillMember.ok) seedRows.push({ userId: message.authorId, source: PARTICIPANT_SOURCE.ADDED })
  }

  let createdByThisAttempt = false
  const threadResult = await createWithCollisionPolicy(channelCreation("thread"), {
    attempt: async () => {
      const created = await queries.communityChannel.createChannel(db, {
        serverId: channel.serverId,
        parentChannelId: message.channelId!,
        parentMessageId: messageId,
        name,
        type: "thread",
        creatorId: actorUserId,
        initialParticipants: seedRows,
      })
      createdByThisAttempt = true
      return created
    },
    refetchWinner: () => queries.communityChannel.getThreadChannelByParentMessage(db, message.channelId!, messageId),
  })
  // get-or-create never returns a structured failure — a !ok is unreachable for
  // this policy (it creates or re-selects, else throws); map to 404 defensively.
  if (!threadResult.ok) return { ok: false, status: 404, error: "thread not found" }
  const childChannel = threadResult.value
  if (createdByThisAttempt) {
    void fanOutToChannel(message.channelId, {
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
    })
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
  authorKind: "human" | "bot"
  parentChannelId: string
  serverId: string
  body: IncomingMessageBody
  threadName?: string
  suppressBroadcast?: boolean
  suppressThreadFanout?: boolean
  attachmentIds?: string[]
  pendingAttachmentIdsToRebind?: string[]
  clientNonce?: string
  expectedSeq?: number
  source?: "cli" | "daemon-http" | "web"
  extraStatements?: unknown[]
}): Promise<CreateMessageWithThreadResult> {
  const { db, authorId, parentChannelId, serverId } = params
  if ((params.pendingAttachmentIdsToRebind?.length ?? 0) > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, status: 400, error: `too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})` }
  }
  const content = typeof params.body.content === "string" ? params.body.content : ""
  const threadName = (params.threadName?.trim() || content.trim() || "thread").slice(0, MAX_CHANNEL_NAME_LENGTH)
  const created = await createCommunityMessage({
    db,
    authorId,
    authorKind: params.authorKind,
    target: { kind: "forum", channelId: parentChannelId, serverId },
    body: params.body,
    source: params.source,
    attachmentIds: params.attachmentIds,
    clientNonce: params.clientNonce,
    expectedSeq: params.expectedSeq,
    suppressBroadcast: params.suppressBroadcast,
    suppressThreadFanout: params.suppressThreadFanout,
    extraStatements: params.extraStatements,
    forumThread: {
      id: nanoid(),
      serverId,
      name: threadName,
      pendingAttachmentIds: params.pendingAttachmentIdsToRebind ?? [],
    },
  })
  if (!created.ok) return { ok: false, status: created.status, error: created.error }
  const childChannel = await queries.communityChannel.getThreadChannelByParentMessage(db, parentChannelId, created.row.id)
  if (!childChannel) throw new Error("committed forum opener is missing its thread")

  return {
    ok: true,
    message: created.row,
    attachments: created.attachments,
    thread: childChannel,
    ...(created.deduped ? { deduped: true } : {}),
  }
}
