import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { FORUM_ARCHIVE_TAG, isForum, queries, MAX_FORUM_TAG_LENGTH, requestsCommunityContractV2 } from "@alook/shared"
import { requireChannelAccess, requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { writeCommunityThreadsRead } from "@/lib/community/thread-read"
import { parseBoundedInt } from "@/lib/community/messages"
import { encodeForumCreatedAtCursor, parseForumCreatedAtCursor } from "@/lib/community/forum-feed-cursor"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Gate through the shared access predicate: a channel in a PRIVATE category
  // must not leak its thread titles/previews to non-members. Public channels
  // behave as before (any server member).
  const version2 = requestsCommunityContractV2(req.headers)
  const channel = await (async () => {
    if (version2) {
      const access = await requireMessageSurfaceAccess(db, channelId, ctx.userId)
      if (!access.ok) return writeError(access.error, access.status)
      return access.value.surface === "channel" ? access.value.channel
        : await queries.communityChannel.getChannelForMember(db, channelId, ctx.userId)
    }
    const access = await requireChannelAccess(db, channelId, ctx.userId)
    return access.ok ? access.value.channel : writeError(access.error, access.status)
  })()
  if (channel instanceof Response) return channel
  if (!channel) return writeError("not found", 404)
  if (version2 && channel.type === "dm") return writeCommunityThreadsRead(db, ctx.userId, channel, [])

  const archivedParam = req.nextUrl.searchParams.get("archived")
  const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined

  const rawTag = req.nextUrl.searchParams.get("tag")
  const tag = rawTag?.trim().toLowerCase()
  if (rawTag !== null && !tag) return writeError("tag is required", 400)
  if (tag && tag.length > MAX_FORUM_TAG_LENGTH) return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)

  const order = req.nextUrl.searchParams.get("order")
  if (order !== null && order !== "createdAt") return writeError("invalid order", 400)

  if (order === "createdAt") {
    if (!isForum(channel.type)) return writeError("not a forum", 400)
    if (archived === true) return writeError("createdAt order only supports active threads", 400)
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
    const hasMore = rows.length > pageSize
    const threads = hasMore ? rows.slice(0, pageSize) : rows
    const last = threads.at(-1)
    const nextCursor = hasMore && last
      ? encodeForumCreatedAtCursor({
        parentChannelId: channelId,
        createdAt: last.createdAt,
        id: last.id,
        tag: tag ?? null,
      })
      : undefined

    const parentMessageIds = threads
      .map((thread) => thread.parentMessageId)
      .filter((id): id is string => !!id)
    const threadIds = threads.map((thread) => thread.id)
    const [parentMessages, firstMessages, tags, participants] = await Promise.all([
      includes.has("parentMessage")
        ? queries.communityMessage.getMessagesByIdsInScope(db, parentMessageIds, { channelId })
        : Promise.resolve([]),
      includes.has("firstMessage")
        ? version2 ? queries.communityMessage.getFirstMessageResourcesByChannelIds(db, threadIds) : queries.communityMessage.getFirstMessageByChannelIds(db, threadIds)
        : Promise.resolve([]),
      includes.has("tags")
        ? queries.communityMessageTag.listTagsForMessages(db, parentMessageIds)
        : Promise.resolve([]),
      includes.has("participants")
        ? queries.communityThread.listParticipantsForChannels(db, threadIds, 5)
        : Promise.resolve([]),
    ])

    if (version2) {
      const firstResources = firstMessages.filter((row): row is Extract<typeof row, { id: string }> => "id" in row)
      return writeCommunityThreadsRead(db, ctx.userId, channel, threads, { messages: [...parentMessages, ...firstResources], tags, participants }, { hasMore, nextCursor: nextCursor ?? null })
    }
    return writeJSON({
      serverId: channel.serverId,
      parentType: channel.type,
      threads,
      included: { parentMessages, firstMessages, tags, participants },
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    })
  }

  let childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived,
    type: "thread",
  })

  const forum = isForum(channel.type)
  const openerIds = childChannels.map((child) => child.parentMessageId).filter((id): id is string => !!id)
  const archivedOpeners = forum
    ? new Set(await queries.communityMessageTag.filterMessageIdsByTag(db, openerIds, FORUM_ARCHIVE_TAG))
    : new Set<string>()

  if (rawTag !== null) {
    const matching = tag === FORUM_ARCHIVE_TAG
      ? archivedOpeners
      : new Set(await queries.communityMessageTag.filterMessageIdsByTag(db, openerIds, tag!))
    childChannels = childChannels.filter((child) => (
      !!child.parentMessageId
      && matching.has(child.parentMessageId)
      && (tag === FORUM_ARCHIVE_TAG || !archivedOpeners.has(child.parentMessageId))
    ))
  } else if (forum) {
    childChannels = childChannels.filter((child) => (
      !child.parentMessageId || !archivedOpeners.has(child.parentMessageId)
    ))
  }

  // Plain nested collection representation. View-specific parent previews,
  // first messages, tags, participants, and creator presentation are composed
  // by consumers through the generic batch resource reads.
  if (version2) return writeCommunityThreadsRead(db, ctx.userId, channel, childChannels)
  return writeJSON({
    serverId: channel.serverId,
    parentType: channel.type,
    threads: childChannels,
  })
})
