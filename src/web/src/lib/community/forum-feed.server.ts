import { queries, type Database } from "@alook/shared"
import { encodeForumCreatedAtCursor, type ForumCreatedAtCursor } from "./forum-feed-cursor"

export async function readCommunityForumRows(db: Database, channelId: string, input: { tag?: string; cursor?: Pick<ForumCreatedAtCursor, "createdAt" | "id">; pageSize: number; includes: ReadonlySet<string> }) {
  const rows = await queries.communityThread.listForumThreadsByCreatedAt(db, { parentChannelId: channelId, ...(input.tag ? { tag: input.tag } : {}), ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.pageSize + 1 })
  const hasMore = rows.length > input.pageSize
  const threads = hasMore ? rows.slice(0, input.pageSize) : rows
  const last = threads.at(-1)
  const nextCursor = hasMore && last ? encodeForumCreatedAtCursor({ parentChannelId: channelId, createdAt: last.createdAt, id: last.id, tag: input.tag ?? null }) : undefined
  const parentMessageIds = threads.flatMap(thread => thread.parentMessageId ? [thread.parentMessageId] : [])
  const threadIds = threads.map(thread => thread.id)
  const [parentMessages, firstMessages, tags, participants] = await Promise.all([
    input.includes.has("parentMessage") ? queries.communityMessage.getMessagesByIdsInScope(db, parentMessageIds, { channelId }) : Promise.resolve([]),
    input.includes.has("firstMessage") ? queries.communityMessage.getFirstMessageResourcesByChannelIds(db, threadIds) : Promise.resolve([]),
    input.includes.has("tags") ? queries.communityMessageTag.listTagsForMessages(db, parentMessageIds) : Promise.resolve([]),
    input.includes.has("participants") ? queries.communityThread.listParticipantsForChannels(db, threadIds, 5) : Promise.resolve([]),
  ])
  return { threads, parentMessages, firstMessages, tags, participants, hasMore, nextCursor }
}
