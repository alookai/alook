import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { FORUM_ARCHIVE_TAG, isForum, queries, MAX_FORUM_TAG_LENGTH, requestsCommunityContract } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { writeCommunityThreadsRead } from "@/lib/community/thread-read"
import { parseBoundedInt } from "@/lib/community/messages"
import { encodeForumCreatedAtCursor, parseForumCreatedAtCursor } from "@/lib/community/forum-feed-cursor"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const currentContract = requestsCommunityContract(req.headers)
  const access = await requireMessageSurfaceAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(currentContract ? access.error : "forbidden", currentContract ? access.status : 403)
  if (!currentContract && access.value.surface === "dm") return writeError("forbidden", 403)
  const channel = access.value.surface === "channel" ? access.value.channel
    : await queries.communityChannel.getChannelForMember(db, channelId, ctx.userId)
  if (!channel) return writeError("not found", 404)
  if (channel.type === "dm") return writeCommunityThreadsRead(db, ctx.userId, channel, [])

  const archivedParam = req.nextUrl.searchParams.get("archived")
  const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined

  const rawTag = req.nextUrl.searchParams.get("tag")
  const tag = rawTag?.trim().toLowerCase()
  if (rawTag !== null && !tag) return writeError("tag is required", 400)
  if (tag && tag.length > MAX_FORUM_TAG_LENGTH) return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)

  const order = req.nextUrl.searchParams.get("order")
  if (order !== null && order !== "createdAt") return writeError("invalid order", 400)

  const includes = new Set(
    (req.nextUrl.searchParams.get("include") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  )
  const allowedIncludes = new Set(["parentMessage", "firstMessage", "tags", "participants"])
  if ([...includes].some((value) => !allowedIncludes.has(value))) {
    return writeError("invalid include", 400)
  }

  let threads: Awaited<ReturnType<typeof queries.communityChannel.listChildChannels>> | Awaited<ReturnType<typeof queries.communityThread.listForumThreadsByCreatedAt>>
  let hasMore = false
  let nextCursor: string | undefined
  if (order === "createdAt") {
    if (!isForum(channel.type)) return writeError("not a forum", 400)
    if (archived === true) return writeError("createdAt order only supports active threads", 400)
    const pageSize = parseBoundedInt(req.nextUrl.searchParams.get("limit"), 50, 100)
    const cursor = parseForumCreatedAtCursor(req.nextUrl.searchParams.get("cursor"), {
      parentChannelId: channelId,
      tag: tag ?? null,
    })
    if (cursor === null) return writeError("invalid cursor", 400)

    const rows = await queries.communityThread.listForumThreadsByCreatedAt(db, {
      parentChannelId: channelId,
      ...(tag ? { tag } : {}),
      ...(cursor ? { cursor } : {}),
      limit: pageSize + 1,
    })
    hasMore = rows.length > pageSize
    threads = hasMore ? rows.slice(0, pageSize) : rows
    const last = threads.at(-1)
    nextCursor = hasMore && last
      ? encodeForumCreatedAtCursor({
        parentChannelId: channelId,
        createdAt: last.createdAt,
        id: last.id,
        tag: tag ?? null,
      })
      : undefined

  } else {
    threads = await queries.communityChannel.listChildChannels(db, channelId, {
    archived,
    type: "thread",
  })

    const forum = isForum(channel.type)
    const openerIds = threads.map((child) => child.parentMessageId).filter((id): id is string => !!id)
    const archivedOpeners = forum
      ? new Set(await queries.communityMessageTag.filterMessageIdsByTag(db, openerIds, FORUM_ARCHIVE_TAG))
      : new Set<string>()

    if (rawTag !== null) {
      const matching = tag === FORUM_ARCHIVE_TAG
        ? archivedOpeners
        : new Set(await queries.communityMessageTag.filterMessageIdsByTag(db, openerIds, tag!))
      threads = threads.filter((child) => (
        !!child.parentMessageId
        && matching.has(child.parentMessageId)
        && (tag === FORUM_ARCHIVE_TAG || !archivedOpeners.has(child.parentMessageId))
      ))
    } else if (forum) {
      threads = threads.filter((child) => (
        !child.parentMessageId || !archivedOpeners.has(child.parentMessageId)
      ))
    }
  }

  const parentMessageIds = threads
    .map((thread) => thread.parentMessageId)
    .filter((id): id is string => !!id)
  const threadIds = threads.map((thread) => thread.id)
  const [parentMessages, firstMessages, tags, participants] = await Promise.all([
    includes.has("parentMessage")
    ? queries.communityMessage.getMessagesByIdsInScope(db, parentMessageIds, { channelId })
    : Promise.resolve([]),
    includes.has("firstMessage")
    ? queries.communityMessage.getFirstMessageResourcesByChannelIds(db, threadIds)
    : Promise.resolve([]),
    includes.has("tags")
    ? queries.communityMessageTag.listTagsForMessages(db, parentMessageIds)
    : Promise.resolve([]),
    includes.has("participants")
    ? queries.communityThread.listParticipantsForChannels(db, threadIds, 5)
    : Promise.resolve([]),
  ])

  if (currentContract) {
    return writeCommunityThreadsRead(db, ctx.userId, channel, threads, { messages: [...parentMessages, ...firstMessages], tags, participants }, { hasMore, nextCursor: nextCursor ?? null })
  }
  return writeJSON({
    serverId: channel.serverId,
    parentType: channel.type,
    threads,
    ...(order === "createdAt" || includes.size ? { included: { parentMessages, firstMessages: firstMessages.map(({ channelId, content }) => ({ channelId, content })), tags, participants }, hasMore, ...(nextCursor ? { nextCursor } : {}) } : {}),
  })
})
