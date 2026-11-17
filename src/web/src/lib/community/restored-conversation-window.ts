import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import type { CommunityRestoredCollections } from "@/lib/query-persister"
import { getCanonicalCommunityMessageResources } from "@/lib/community-db/sync"
import { assessConversationScope } from "./conversation-entry"
import { messageWindowPage } from "./models/message"
import type { MessageWindowData } from "./message-window"

export function restoreConversationDisplayWindows(registry: CommunityDbRegistry, input: CommunityRestoredCollections) {
  const client = registry.queryClient
  for (const window of input.messageWindows ?? []) {
    const channel = registry.collections.channels.get(window.channelId)
    if (!channel || channel.type === "forum") continue
    const target = { channelId: channel.id, serverId: channel.serverId }
    if (!assessConversationScope(client, target).scope || client.getQueryData(window.key) !== undefined) continue
    const rows = window.data.pages.flatMap(page => page.messages.map(ref => registry.collections.messages.get(ref.id)))
    if (rows.some(row => !row || row.channelId !== channel.id)) continue
    if (!getCanonicalCommunityMessageResources(client, rows)) continue
    client.setQueryData<MessageWindowData>(window.key, {
      pages: window.data.pages.map(page => {
        const messages = page.messages.map(ref => registry.collections.messages.get(ref.id)!)
        const oldest = messages[0], newest = messages.at(-1)
        return { ...page, ...messageWindowPage({ messages }), hasMoreOlder: true, hasMoreNewer: true,
          ...(oldest ? { olderCursor: page.olderCursor ?? `${oldest.createdAt}|${oldest.id}` } : {}),
          ...(newest ? { newerCursor: page.newerCursor ?? `${newest.createdAt}|${newest.id}` } : {}) }
      }),
      pageParams: window.data.pageParams,
    }, { updatedAt: window.updatedAt })
  }
}
