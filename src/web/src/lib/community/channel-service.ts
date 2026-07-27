import {
  queries,
  isForum,
  isPost,
  slugify,
  canManageServer,
  isUniqueConstraintError,
  MESSAGE_PREVIEW_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  PARTICIPANT_SOURCE,
  type ChannelType,
  type MentionType,
  type ParticipantSource,
  type Database,
} from "@alook/shared"
import { fanOutToChannel, fanOutToServerMembers, broadcastToUserSafe } from "./fanout"
import { requireServerMember, requireChannelMember, type ChannelAccess } from "./permissions"
import { logAudit } from "./audit"
import { avatarInitial } from "./avatar"
import { createCommunityMessage } from "./message-handler"

// The human composer sends attachments as objects; the agent pre-mint path
// sends ids. Only the human (object) shape reaches `createChannelUnified`'s
// post arm — the route forwards them straight to `createCommunityMessage`.
type ComposerAttachment = {
  url: string
  filename: string
  contentType: string
  size: number
  width?: number
  height?: number
}

// The single serialized shape returned by `POST /channels` and each item of
// `GET /channels/[id]/children`. Superset: the top-level fields are present for
// every channel type; the sub-channel summary (`parent`/`parentSeq`) is filled
// for post + thread children; the post card fields
// (`creator`/`authorId`/`authorAvatar`/`preview`/`tags`/`participants`) are
// filled only for a post and null / [] otherwise.
export type ChannelDTO = {
  id: string
  name: string
  type: ChannelType
  parentChannelId: string | null
  parentMessageId: string | null
  categoryId: string | null
  topic: string | null
  position: number
  createdAt: string
  lastMessageAt: string | null
  messageCount: number
  parent: { authorName: string; text: string } | null
  parentSeq?: number
  creator: { id: string; name: string; avatar: string } | null
  authorId: string | null
  authorAvatar: string | null
  preview: string | null
  tags: string[]
  participants: { id: string; name: string; avatar: string }[]
}

export type CreateChannelServiceInput =
  | {
      type: "text" | "forum"
      serverId: string
      name: string
      categoryId?: string | null
      topic?: string
    }
  | {
      type: "post"
      parentChannelId: string
      name: string
      content: string
      attachments?: ComposerAttachment[]
      mentionType?: MentionType
    }
  | {
      type: "thread"
      parentMessageId: string
      // Undefined only on the agent (resolve-ref) path — the service derives
      // the name from the root message. The human route always supplies it.
      name?: string
    }

export type CreateChannelServiceResult =
  | { ok: true; created: boolean; channel: ChannelDTO }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; error: string }

type CreateChannelOpts = {
  // Human thread path seeds the creator ("spoke") + root author ("added"),
  // emits CHILD_CHANNEL_CREATE, and runs the actor membership gate. The agent
  // (resolve-ref) path passes both false → no seeding, no fan-out, no membership
  // gate, and the name is derived from the root message (createThreadChannel
  // parity). Ignored by the text/forum/post arms.
  seedCreator?: boolean
  seedRootAuthor?: boolean
}

const EMPTY_CARD = {
  parent: null,
  creator: null,
  authorId: null,
  authorAvatar: null,
  preview: null,
  tags: [] as string[],
  participants: [] as { id: string; name: string; avatar: string }[],
}

// The query layer types `createChannel` / `getThreadChannelByParentMessage`
// loosely (`communityChannel` is `SQLiteTableWithColumns<any>`), so this reads
// the fields it needs off a permissive row shape rather than casting `any`.
type ChannelRow = {
  id: string
  name: string
  type?: string | null
  categoryId?: string | null
  topic?: string | null
  position?: number | null
  parentChannelId?: string | null
  parentMessageId?: string | null
  messageCount?: number | null
  lastMessageAt?: string | null
  createdAt: string
}

function baseChannelDTO(row: Record<string, unknown>): ChannelDTO {
  const r = row as ChannelRow
  return {
    id: r.id,
    name: r.name,
    type: (r.type ?? "text") as ChannelType,
    parentChannelId: r.parentChannelId ?? null,
    parentMessageId: r.parentMessageId ?? null,
    categoryId: r.categoryId ?? null,
    topic: r.topic ?? null,
    position: r.position ?? 0,
    createdAt: r.createdAt,
    lastMessageAt: r.lastMessageAt ?? null,
    messageCount: r.messageCount ?? 0,
    ...EMPTY_CARD,
  }
}

export async function createChannelUnified(
  db: Database,
  actor: { userId: string },
  input: CreateChannelServiceInput,
  opts?: CreateChannelOpts,
): Promise<CreateChannelServiceResult> {
  if (input.type === "text" || input.type === "forum") {
    return createTopLevelChannel(db, actor, input)
  }
  if (input.type === "post") {
    return createPostChannel(db, actor, input)
  }
  if (input.type === "thread") {
    return createThreadChannelUnified(db, actor, input, opts)
  }
  return { ok: false, status: 400, error: "unknown channel type" }
}

async function createTopLevelChannel(
  db: Database,
  actor: { userId: string },
  input: Extract<CreateChannelServiceInput, { type: "text" | "forum" }>,
): Promise<CreateChannelServiceResult> {
  const auth = await requireServerMember(db, input.serverId, actor.userId)
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error }
  const member = auth.value!

  const name = slugify(input.name.trim())
  if (!name) return { ok: false, status: 400, error: "name is required" }

  const isAdmin = canManageServer(member.role)
  let isPrivateCategory = false
  if (input.categoryId) {
    const category = await queries.communityCategory.getCategory(db, input.categoryId)
    if (!category || category.serverId !== input.serverId) {
      return { ok: false, status: 404, error: "category not found" }
    }
    isPrivateCategory = !!category.private
  }
  if (!isPrivateCategory && !isAdmin) {
    return { ok: false, status: 403, error: "admin permission required" }
  }

  let row
  try {
    row = await queries.communityChannel.createChannel(db, {
      serverId: input.serverId,
      categoryId: input.categoryId || null,
      name,
      type: input.type,
      topic: input.topic,
      creatorId: actor.userId,
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, status: 409, error: "a channel with this name already exists" }
    }
    throw err
  }

  if (isPrivateCategory) {
    await queries.communityChannel.createChannelMember(db, {
      channelId: row.id,
      userId: actor.userId,
      addedBy: actor.userId,
    })
  }

  const wsChannel = {
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
      serverId: input.serverId,
      channel: wsChannel,
    })
  } else {
    await fanOutToServerMembers(input.serverId, {
      type: WS_EVENTS.CHANNEL_CREATE,
      serverId: input.serverId,
      channel: wsChannel,
    })
  }

  logAudit(db, {
    serverId: input.serverId,
    actorId: actor.userId,
    action: "channel_create",
    targetType: "channel",
    targetId: row.id,
  })

  return { ok: true, created: true, channel: baseChannelDTO(row) }
}

async function createPostChannel(
  db: Database,
  actor: { userId: string },
  input: Extract<CreateChannelServiceInput, { type: "post" }>,
): Promise<CreateChannelServiceResult> {
  const auth = await requireChannelMember(db, input.parentChannelId, actor.userId)
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error }
  const forum = auth.value

  if (!isForum(forum.type)) {
    return { ok: false, status: 400, error: "channel is not a forum" }
  }

  const name = slugify(input.name.trim())
  if (!name) return { ok: false, status: 400, error: "name is required" }

  const content = input.content
  const hasContent = content.trim().length > 0
  const hasAttachments = !!input.attachments && input.attachments.length > 0
  if (!hasContent && !hasAttachments) {
    return { ok: false, status: 400, error: "post is empty" }
  }

  const postChannel = await queries.communityChannel.createChannel(db, {
    serverId: forum.serverId,
    parentChannelId: input.parentChannelId,
    name,
    type: "post",
    creatorId: actor.userId,
  })

  // Enroll the creator directly (not by routing the first message as
  // kind:"post") so the CHILD_CHANNEL_UPDATE that would fire doesn't collide
  // with the CHILD_CHANNEL_CREATE emitted below.
  await queries.communityThread.addThreadParticipants(db, postChannel.id, [
    { userId: actor.userId, source: PARTICIPANT_SOURCE.SPOKE },
  ])

  // Route the opener through the unified pipeline as kind:"channel" with the
  // post's OWN id (NOT kind:"post") so it gets mention extraction + private
  // audience scoping without firing a colliding CHILD_CHANNEL_UPDATE.
  const created = await createCommunityMessage({
    db,
    authorId: actor.userId,
    target: { kind: "channel", channelId: postChannel.id, serverId: forum.serverId },
    body: { content, attachments: input.attachments, mentionType: input.mentionType },
  })
  if (!created.ok) return { ok: false, status: created.status, error: created.error }
  const message = created.row

  const creator = await queries.user.getUserSelf(db, actor.userId)
  const authorName = creator ? creator.name : ""
  const authorAvatar = creator?.image ?? avatarInitial(authorName)
  const preview = content.slice(0, MESSAGE_PREVIEW_LENGTH)

  await fanOutToChannel(input.parentChannelId, {
    type: WS_EVENTS.CHILD_CHANNEL_CREATE,
    parentChannelId: input.parentChannelId,
    channel: {
      id: postChannel.id,
      name: postChannel.name,
      type: "post" as const,
      creatorId: actor.userId,
      createdAt: postChannel.createdAt,
    },
  })

  const dto = baseChannelDTO({ ...postChannel, lastMessageAt: message.createdAt })
  return {
    ok: true,
    created: true,
    channel: {
      ...dto,
      // The body IS the first message; the reply-count badge reads 0 on a
      // freshly created post.
      messageCount: 0,
      parent: { authorName, text: preview },
      creator: { id: actor.userId, name: authorName, avatar: authorAvatar },
      authorId: actor.userId,
      authorAvatar,
      preview,
      tags: [],
      participants: [{ id: actor.userId, name: authorName, avatar: authorAvatar }],
    },
  }
}

async function createThreadChannelUnified(
  db: Database,
  actor: { userId: string },
  input: Extract<CreateChannelServiceInput, { type: "thread" }>,
  opts?: CreateChannelOpts,
): Promise<CreateChannelServiceResult> {
  const seedCreator = opts?.seedCreator ?? true
  const seedRootAuthor = opts?.seedRootAuthor ?? true
  // The agent (resolve-ref) path opts out of seeding, fan-out, the membership
  // gate, and the explicit name — matching the old createThreadChannel.
  const isAgentPath = !seedCreator && !seedRootAuthor

  const message = await queries.communityMessage.getMessage(db, input.parentMessageId)
  if (!message) return { ok: false, status: 404, error: "message not found" }
  if (!message.channelId) return { ok: false, status: 400, error: "message is not in a channel" }
  const parentChannelId = message.channelId

  let serverId: string
  if (isAgentPath) {
    const parent = await queries.communityChannel.getChannel(db, parentChannelId)
    if (!parent) return { ok: false, status: 404, error: "channel not found" }
    // Threads may only root on a TOP-LEVEL channel — a grandchild defeats the
    // single-level privacy anchor climb and leaks a private forum's thread.
    if (parent.parentChannelId) {
      return { ok: false, status: 400, error: "can't start a thread on a message in a thread or forum post" }
    }
    serverId = parent.serverId
  } else {
    const auth = await requireChannelMember(db, parentChannelId, actor.userId)
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error }
    const channel = auth.value
    if (channel.parentChannelId) {
      return { ok: false, status: 400, error: "can't start a thread on a message in a thread or forum post" }
    }
    serverId = channel.serverId
  }

  // Dedupe: one thread per message. On the human path this returns 409 (via
  // created:false); the agent path reuses the winner.
  const existing = await queries.communityChannel.getThreadChannelByParentMessage(
    db,
    parentChannelId,
    input.parentMessageId,
  )
  if (existing) return { ok: true, created: false, channel: baseChannelDTO(existing) }

  const name = isAgentPath
    ? deriveThreadName(message.content)
    : (input.name ?? "").trim()
  if (!name) return { ok: false, status: 400, error: "name is required" }

  let childChannel
  try {
    childChannel = await queries.communityChannel.createChannel(db, {
      serverId,
      parentChannelId,
      parentMessageId: input.parentMessageId,
      name,
      type: "thread",
      creatorId: actor.userId,
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Lost the race to a concurrent thread-create — re-select the winner.
      const winner = await queries.communityChannel.getThreadChannelByParentMessage(
        db,
        parentChannelId,
        input.parentMessageId,
      )
      if (winner) return { ok: true, created: false, channel: baseChannelDTO(winner) }
    }
    throw err
  }

  if (seedCreator || seedRootAuthor) {
    const seedRows: { userId: string; source: ParticipantSource }[] = []
    if (seedCreator) seedRows.push({ userId: actor.userId, source: PARTICIPANT_SOURCE.SPOKE })
    // The root author is only enrolled if they are STILL a member of the
    // parent channel — seeding them unconditionally could push a private
    // thread to someone who lost access.
    if (seedRootAuthor && message.authorId && message.authorId !== actor.userId) {
      const authorStillMember = await requireChannelMember(db, parentChannelId, message.authorId)
      if (authorStillMember.ok) seedRows.push({ userId: message.authorId, source: PARTICIPANT_SOURCE.ADDED })
    }
    if (seedRows.length > 0) {
      await queries.communityThread.addThreadParticipants(db, childChannel.id, seedRows)
    }

    await fanOutToChannel(
      parentChannelId,
      {
        type: WS_EVENTS.CHILD_CHANNEL_CREATE,
        parentChannelId,
        channel: {
          id: childChannel.id,
          name: childChannel.name,
          type: "thread" as const,
          creatorId: actor.userId,
          createdAt: childChannel.createdAt,
        },
        parentMessageId: input.parentMessageId,
      },
      { excludeUserId: actor.userId },
    )
  }

  return { ok: true, created: true, channel: baseChannelDTO(childChannel) }
}

function deriveThreadName(content: string | null | undefined): string {
  const raw = content?.trim() ?? ""
  return raw.length > 0 ? raw.slice(0, 40) : "Thread"
}

// ---------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------

export type UpdateChannelServiceInput = {
  name?: string
  topic?: string
  categoryId?: string | null
  // Already-normalized tag array (or null to clear). The route validates the
  // wire shape; the service persists the stringified form.
  forumTags?: string[] | null
}

// Move / edit + persist + fan-out + audit for PATCH /channels/[id]. The route
// resolves `requireChannelAccess` (which owns the 404-vs-403 gate) and passes
// its result in; the post-own-creator tag carve-out lives here.
export async function updateChannelUnified(
  db: Database,
  actor: { userId: string; access: ChannelAccess },
  channelId: string,
  input: UpdateChannelServiceInput,
): Promise<
  | { ok: true; row: NonNullable<Awaited<ReturnType<typeof queries.communityChannel.updateChannel>>> }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string }
> {
  const { access } = actor
  const channel = access.channel
  const isAdmin = canManageServer(access.member.role)

  // A post's OWN creator may edit that post's tags even without canManage.
  const canEditPostTags = isPost(channel.type) && channel.creatorId === actor.userId
  if (!access.canManage && !canEditPostTags) {
    return { ok: false, status: 403, error: "forbidden" }
  }

  // A creator-without-canManage reached here only for the tag carve-out — they
  // may edit forumTags and nothing else.
  if (!access.canManage) {
    const nonTagField =
      input.name !== undefined || input.topic !== undefined || input.categoryId !== undefined
    if (nonTagField) return { ok: false, status: 403, error: "forbidden" }
  }

  const changes: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null } = {}

  if (input.name !== undefined) {
    const trimmed = input.name.trim()
    if (!trimmed || trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
      return { ok: false, status: 400, error: `name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters` }
    }
    const normalized = slugify(trimmed)
    if (!normalized) return { ok: false, status: 400, error: "name is required" }
    changes.name = normalized
  }

  if (input.topic !== undefined) {
    if (input.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return { ok: false, status: 400, error: `topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters` }
    }
    changes.topic = input.topic
  }

  if (input.categoryId !== undefined) {
    // Moving between categories is admin-only AND may not cross a
    // public↔private boundary without member reconciliation.
    if (!isAdmin) return { ok: false, status: 403, error: "admin permission required" }
    let targetPrivate = false
    if (input.categoryId !== null) {
      const category = await queries.communityCategory.getCategory(db, input.categoryId)
      if (!category || category.serverId !== channel.serverId) {
        return { ok: false, status: 404, error: "category not found" }
      }
      targetPrivate = !!category.private
    }
    const currentPrivate = access.anchor.categoryId
      ? await queries.communityChannel.isChannelPrivate(db, channelId)
      : false
    if (targetPrivate !== currentPrivate) {
      return { ok: false, status: 400, error: "Can't move a channel across a public/private boundary" }
    }
    changes.categoryId = input.categoryId
  }

  if (input.forumTags !== undefined) {
    // Tags are a per-post concept: only a `post` carries a selected-tag list
    // (a forum's tag vocabulary is derived from its posts' union).
    if (!isPost(channel.type)) {
      return { ok: false, status: 400, error: "only forum posts can have tags" }
    }
    if (input.forumTags !== null) {
      const normalized = [...new Set(input.forumTags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      changes.forumTags = JSON.stringify(normalized)
    } else {
      changes.forumTags = null
    }
  }

  if (Object.keys(changes).length === 0) {
    return { ok: false, status: 400, error: "no changes provided" }
  }

  let updated
  try {
    updated = await queries.communityChannel.updateChannel(db, channelId, changes)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, status: 409, error: "a channel with this name already exists" }
    }
    throw err
  }
  if (!updated) return { ok: false, status: 404, error: "channel not found" }

  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  const event = {
    type: WS_EVENTS.CHANNEL_UPDATE,
    serverId: channel.serverId,
    channelId,
    changes,
  } as const
  if (isPrivate) {
    await fanOutToChannel(channelId, event)
  } else {
    await fanOutToServerMembers(channel.serverId, event)
  }

  logAudit(db, {
    serverId: channel.serverId,
    actorId: actor.userId,
    action: "channel_update",
    targetType: "channel",
    targetId: channelId,
    changes: JSON.stringify(changes),
  })

  return { ok: true, row: updated }
}

// Delete + audience-scoped fan-out + audit for DELETE /channels/[id]. The
// post-own-creator delete carve-out lives here.
export async function deleteChannelUnified(
  db: Database,
  actor: { userId: string; access: ChannelAccess },
  channelId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 404; error: string }> {
  const { access } = actor
  const channel = access.channel

  const canDeletePost = isPost(channel.type) && channel.creatorId === actor.userId
  if (!access.canManage && !canDeletePost) {
    return { ok: false, status: 403, error: "forbidden" }
  }

  // Resolve the private audience BEFORE deleting (member rows cascade away).
  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  const audience = isPrivate
    ? await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
    : null

  const deleted = await queries.communityChannel.deleteChannel(db, channelId)
  if (!deleted) return { ok: false, status: 404, error: "channel not found" }

  const event = {
    type: WS_EVENTS.CHANNEL_DELETE,
    serverId: channel.serverId,
    channelId,
    parentChannelId: channel.parentChannelId,
  } as const
  if (audience) {
    await Promise.all(audience.map((userId) => broadcastToUserSafe(userId, event)))
  } else {
    await fanOutToServerMembers(channel.serverId, event)
  }

  logAudit(db, {
    serverId: channel.serverId,
    actorId: actor.userId,
    action: "channel_delete",
    targetType: "channel",
    targetId: channelId,
  })

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Child channel listing (GET /channels/[id]/children)
// ---------------------------------------------------------------------------

type ChildKind = "post" | "thread"

export async function listChildChannelsForApi(
  db: Database,
  access: ChannelAccess,
  parentChannelId: string,
  opts: { type: ChildKind; tag?: string | null; archived?: boolean },
): Promise<{ ok: true; children: ChannelDTO[] } | { ok: false; status: 400; error: string }> {
  if (opts.type === "post") {
    return listPostChildren(db, access, parentChannelId, opts.tag ?? null)
  }
  return listThreadChildren(db, parentChannelId, opts.archived)
}

async function listPostChildren(
  db: Database,
  access: ChannelAccess,
  parentChannelId: string,
  tag: string | null,
): Promise<{ ok: true; children: ChannelDTO[] } | { ok: false; status: 400; error: string }> {
  if (!isForum(access.channel.type)) {
    return { ok: false, status: 400, error: "channel is not a forum" }
  }

  let childChannels = await queries.communityChannel.listChildChannels(db, parentChannelId, {
    archived: false,
    type: "post",
  })
  if (tag) {
    childChannels = childChannels.filter((ch) => ch.tags.includes(tag))
  }

  const creatorIds = [...new Set(childChannels.map((t) => t.creatorId).filter(Boolean) as string[])]
  const creators = creatorIds.length > 0 ? await queries.user.getUsersByIds(db, creatorIds) : []
  const creatorMap = new Map(creators.map((u) => [u.id, u]))

  const postChannelIds = childChannels.map((t) => t.id)
  const firstMessages = postChannelIds.length > 0
    ? await queries.communityMessage.getFirstMessageByChannelIds(db, postChannelIds)
    : []
  const previewMap = new Map(firstMessages.map((m) => [m.channelId, m.content]))

  const participantRows = postChannelIds.length > 0
    ? await queries.communityThread.listParticipantsForChannels(db, postChannelIds)
    : []
  const participantsByPost = new Map<string, { id: string; name: string; avatar: string }[]>()
  for (const r of [...participantRows].sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    const list = participantsByPost.get(r.channelId) ?? []
    list.push({ id: r.userId, name: r.userName ?? "", avatar: r.userImage ?? avatarInitial(r.userName ?? "") })
    participantsByPost.set(r.channelId, list)
  }

  const children = childChannels.map((t) => {
    const creator = t.creatorId ? creatorMap.get(t.creatorId) : null
    const authorName = creator ? creator.name : ""
    const authorAvatar = creator?.image ?? avatarInitial(authorName)
    const preview = (previewMap.get(t.id) ?? "").slice(0, MESSAGE_PREVIEW_LENGTH)
    const dto = baseChannelDTO(t)
    return {
      ...dto,
      // Excludes the body message — the body IS the first message; the badge
      // shows reply count, not total message count.
      messageCount: Math.max(0, (t.messageCount ?? 0) - 1),
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent: { authorName, text: preview },
      creator: t.creatorId ? { id: t.creatorId, name: authorName, avatar: authorAvatar } : null,
      authorId: t.creatorId ?? "",
      authorAvatar,
      preview,
      tags: t.tags ?? [],
      participants: participantsByPost.get(t.id) ?? [],
    }
  })

  return { ok: true, children }
}

async function listThreadChildren(
  db: Database,
  parentChannelId: string,
  archived: boolean | undefined,
): Promise<{ ok: true; children: ChannelDTO[] }> {
  const childChannels = await queries.communityChannel.listChildChannels(db, parentChannelId, {
    archived,
    type: "thread",
  })

  const parentIds = [
    ...new Set(childChannels.filter((r) => r.parentMessageId).map((r) => r.parentMessageId!)),
  ]
  const creatorIds = [
    ...new Set(
      childChannels.filter((r) => !r.parentMessageId && r.creatorId).map((r) => r.creatorId!),
    ),
  ]
  const firstMessageChannelIds = [
    ...new Set(childChannels.filter((r) => !r.parentMessageId).map((r) => r.id)),
  ]

  const [parentMessages, creators, firstMessages] = await Promise.all([
    queries.communityMessage.getMessagesByIds(db, parentIds),
    queries.user.getUsersByIds(db, creatorIds),
    queries.communityMessage.getFirstMessageByChannelIds(db, firstMessageChannelIds),
  ])

  const parentMessageMap = new Map(parentMessages.map((m) => [m.id, m]))
  const creatorMap = new Map(creators.map((u) => [u.id, u]))
  const firstMessageMap = new Map(firstMessages.map((m) => [m.channelId as string, m.content]))

  const children = childChannels.map((t) => {
    let parent = { authorName: "", text: "" }
    let parentSeq: number | undefined
    if (t.parentMessageId) {
      const msg = parentMessageMap.get(t.parentMessageId)
      if (msg) {
        parent = { authorName: msg.authorName, text: (msg.content ?? "").slice(0, 100) }
        parentSeq = msg.seq
      }
    } else if (t.creatorId) {
      const creator = creatorMap.get(t.creatorId)
      if (creator) parent = { authorName: creator.name, text: "" }
      const firstText = firstMessageMap.get(t.id)
      if (firstText !== undefined) {
        parent = { ...parent, text: (firstText ?? "").slice(0, 100) }
      }
    }
    const dto = baseChannelDTO(t)
    return {
      ...dto,
      messageCount: t.messageCount ?? 0,
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent,
      ...(parentSeq !== undefined ? { parentSeq } : {}),
    }
  })

  return { ok: true, children }
}
