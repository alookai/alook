import {
  canManageServer,
  FORUM_ARCHIVE_TAG,
  MAX_FORUM_TAG_LENGTH,
  MAX_FORUM_TAGS_PER_POST,
  queries,
  supportsMessageProperty,
  WS_EVENTS,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { requireChannelAccess } from "@/lib/community/permissions"

type OperationError = { ok: false; status: 400 | 401 | 403 | 404; error: string }
type OperationOk<T> = { ok: true; value: T }
type OperationResult<T> = OperationOk<T> | OperationError

function normalizeForumTags(raw: unknown): OperationResult<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, error: "tags must be an array" }
  }
  if (raw.some((tag) => typeof tag !== "string")) {
    return { ok: false, status: 400, error: "tags must contain only strings" }
  }
  const tags = [...new Set(raw.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
  if (tags.filter((tag) => tag !== FORUM_ARCHIVE_TAG).length > MAX_FORUM_TAGS_PER_POST) {
    return { ok: false, status: 400, error: `too many tags (max ${MAX_FORUM_TAGS_PER_POST})` }
  }
  if (tags.some((tag) => tag.length > MAX_FORUM_TAG_LENGTH)) {
    return { ok: false, status: 400, error: `tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters` }
  }
  return { ok: true, value: tags }
}

async function authorizeForumTagTarget(
  db: Database,
  messageId: string,
  userId: string,
  requireEdit: boolean,
): Promise<OperationResult<{
  message: NonNullable<Awaited<ReturnType<typeof queries.communityMessage.getMessage>>>
  threadId: string
}>> {
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return { ok: false, status: 404, error: "message not found" }

  const access = await requireChannelAccess(db, message.channelId, userId)
  if (!access.ok) return access
  if (!supportsMessageProperty(access.value.channel.type, "tag")) {
    return { ok: false, status: 400, error: "tags are only supported on forum opener messages" }
  }

  const thread = await queries.communityChannel.getThreadChannelByParentMessage(
    db,
    message.channelId,
    message.id,
  )
  if (!thread || thread.type !== "thread") {
    return { ok: false, status: 400, error: "message is not a forum opener" }
  }

  if (requireEdit) {
    const mayEdit = message.authorId === userId || canManageServer(access.value.member.role)
    if (!mayEdit) return { ok: false, status: 403, error: "forbidden" }
  }
  return { ok: true, value: { message, threadId: thread.id } }
}

function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((tag, index) => tag === sortedB[index])
}

async function replaceAuthorizedTags(
  db: Database,
  target: { message: { id: string; channelId: string }; threadId: string },
  tags: string[],
): Promise<{ tags: string[]; changed: boolean }> {
  const current = await queries.communityMessageTag.listTagsForMessage(db, target.message.id)
  if (sameTagSet(current, tags)) return { tags, changed: false }

  await queries.communityMessageTag.replaceMessageTags(db, {
    messageId: target.message.id,
    tags,
  })
  await fanOutToChannel(target.message.channelId, {
    type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
    parentChannelId: target.message.channelId,
    channelId: target.threadId,
    changes: { tags },
  })
  return { tags, changed: true }
}

export async function replaceForumTagsForActor(
  db: Database,
  input: { messageId: string; userId: string; tags: unknown },
): Promise<OperationResult<{ tags: string[]; changed: boolean }>> {
  const normalized = normalizeForumTags(input.tags)
  if (!normalized.ok) return normalized
  const target = await authorizeForumTagTarget(db, input.messageId, input.userId, true)
  if (!target.ok) return target
  return { ok: true, value: await replaceAuthorizedTags(db, target.value, normalized.value) }
}

export async function mutateForumTagsForActor(
  db: Database,
  input: {
    messageId: string
    userId: string
    action: "set" | "remove"
    tags: unknown
  },
): Promise<OperationResult<{ tags: string[]; changed: boolean }>> {
  const requested = normalizeForumTags(input.tags)
  if (!requested.ok) return requested
  const target = await authorizeForumTagTarget(db, input.messageId, input.userId, true)
  if (!target.ok) return target

  const current = (await queries.communityMessageTag.listTagsForMessage(db, input.messageId)).sort()
  const currentSet = new Set(current)
  const requestedSet = new Set(requested.value)
  const intended = input.action === "set"
    ? [...new Set([...current, ...requested.value])].sort()
    : current.filter((tag) => !requestedSet.has(tag))
  const normalizedIntended = normalizeForumTags(intended)
  if (!normalizedIntended.ok) return normalizedIntended

  let changed = false
  if (input.action === "set") {
    const additions = requested.value.filter((tag) => !currentSet.has(tag))
    for (const tag of additions) {
      await queries.communityMessageTag.addMessageTag(db, { messageId: input.messageId, tag })
    }
    changed = additions.length > 0
  } else {
    for (const tag of requested.value) {
      const removed = await queries.communityMessageTag.removeMessageTag(db, {
        messageId: input.messageId,
        tag,
      })
      changed ||= removed !== null
    }
  }
  if (!changed) {
    return { ok: true, value: { tags: requested.value, changed: false } }
  }

  const tags = (await queries.communityMessageTag.listTagsForMessage(db, input.messageId)).sort()
  await fanOutToChannel(target.value.message.channelId, {
    type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
    parentChannelId: target.value.message.channelId,
    channelId: target.value.threadId,
    changes: { tags },
  })
  return { ok: true, value: { tags: requested.value, changed: true } }
}

export async function listForumTagsForActor(
  db: Database,
  input: { messageId: string; userId: string },
): Promise<OperationResult<string[]>> {
  const target = await authorizeForumTagTarget(db, input.messageId, input.userId, false)
  if (!target.ok) return target
  const tags = await queries.communityMessageTag.listTagsForMessage(db, input.messageId)
  return { ok: true, value: tags.sort() }
}
