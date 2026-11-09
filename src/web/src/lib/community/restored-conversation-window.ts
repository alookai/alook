import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import type { CommunityRestoredCollections } from "@/lib/query-persister"
import { getCanonicalCommunityMessageResources } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { assessConversationScope } from "./conversation-entry"
import { messageWindowPage } from "./models/message"
import type { MessageWindowData } from "./message-window"

export function restoreConversationDisplayWindows(registry: CommunityDbRegistry, input: CommunityRestoredCollections) {
  const client = registry.queryClient
  const channels = new Map<string, string[]>()
  for (const row of input.messages?.rows ?? []) {
    const ids = channels.get(row.channelId) ?? []
    ids.push(row.id)
    channels.set(row.channelId, ids)
  }
  for (const [channelId, ids] of channels) {
    const channel = registry.collections.channels.get(channelId)
    if (!channel || channel.type === "forum") continue
    const target = { channelId, serverId: channel.serverId }
    if (!assessConversationScope(client, target).scope) continue
    const key = communityKeys.channelMessages(channelId)
    if (client.getQueryData(key) !== undefined) continue
    const rows = ids.flatMap(id => {
      const row = registry.collections.messages.get(id)
      return row?.channelId === channelId && typeof row.seq === "number" && row.seq > 0 ? [row] : []
    }).sort((left, right) => left.seq! - right.seq!)
    if (!rows.length || new Set(rows.map(row => row.seq)).size !== rows.length) continue
    let first = rows.length - 1
    while (first > 0 && rows[first - 1].seq === rows[first].seq! - 1) first--
    const resources = getCanonicalCommunityMessageResources(client, rows.slice(first))
    if (!resources) continue
    const oldest = resources.messages[0]!, newest = resources.messages.at(-1)!
    client.setQueryData<MessageWindowData>(key, {
      pages: [messageWindowPage({ messages: resources.messages,
        hasMoreOlder: true, hasMoreNewer: true, latestSeq: newest.seq,
        olderCursor: `${oldest.createdAt}|${oldest.id}`, newerCursor: `${newest.createdAt}|${newest.id}` })],
      pageParams: [{ mode: "newest" }],
    }, { updatedAt: input.messages!.updatedAt })
  }
}
