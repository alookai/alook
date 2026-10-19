import { queries, type CommunityContract, type Database } from "@alook/shared"
import { buildAnchorResponse, buildPaginatedResponse, buildSinceResponse, type parseCommunityMessageWindow } from "./messages"
import { enrichMessages } from "./enrich-messages"
import type { DoorTarget } from "./message-door"
import type { MessagePage } from "./read-contract"

export async function readCommunityMessageWindow(db: Database, input: {
  viewerId: string
  target: DoorTarget
  window: ReturnType<typeof parseCommunityMessageWindow>
  contract: CommunityContract
  tag?: string
}): Promise<{ ok: true; page: MessagePage } | { ok: false; status: 404; error: string }> {
  const { viewerId, target, window: { anchorId, since, cursor, pageSize }, contract, tag } = input
  const channelId = target.target.channelId
  const scope = { channelId, isDm: target.isDm, isForum: target.target.kind === "forum", contract }
  const surfaceReceipt = { channelId, surfaceKind: target.target.kind }

  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    if (!anchor) return { ok: false, status: 404, error: "anchor not found" }
    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId, anchor: { createdAt: anchor.createdAt, id: anchor.id }, limit: pageSize, tag,
    })
    const { items, ...page } = buildAnchorResponse(around.older, around.newer, {
      hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer,
    })
    const enriched = await enrichMessages(db, viewerId, scope, items)
    return { ok: true, page: { ...page, ...enriched, surfaceReceipt } }
  }

  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, { channelId, since, limit: pageSize, tag })
    const { items, ...page } = buildSinceResponse(rows, pageSize)
    const enriched = await enrichMessages(db, viewerId, scope, items)
    return { ok: true, page: { ...page, ...enriched, surfaceReceipt } }
  }

  const rows = await queries.communityMessage.listMessages(db, { channelId, cursor, limit: pageSize + 1, tag })
  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const enriched = await enrichMessages(db, viewerId, scope, items.slice().reverse())
  return { ok: true, page: { ...enriched, hasMore, cursor: nextCursor, surfaceReceipt } }
}
