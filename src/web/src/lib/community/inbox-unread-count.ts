import type { Mention, UnreadDm, UnreadServer } from "./models/inbox"

export function inboxUnreadCount({ servers, dms, mentions, friendRequestCount, pendingChannelIds = [] }: {
  servers: UnreadServer[]
  dms: UnreadDm[]
  mentions: Mention[]
  friendRequestCount: number
  pendingChannelIds?: string[]
}) {
  const conversations = new Set(pendingChannelIds)
  for (const server of servers) {
    for (const channel of server.channels) {
      if (channel.hasDirectUnread !== false) conversations.add(channel.channelId)
      for (const child of channel.children) conversations.add(child.channelId)
    }
  }
  for (const dm of dms) conversations.add(dm.channelId)
  for (const mention of mentions) conversations.add(mention.channelId ?? `mention:${mention.id}`)
  return conversations.size + friendRequestCount
}
