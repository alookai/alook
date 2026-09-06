import { queries, type CommunityWsEvent, type Database } from "@alook/shared"

type AccessKind = "channel" | "child-create" | "child-update" | "channel-create" | "mention" | "notification" | "control"

export const communityContentAccessKinds = {
  "community:message.create": "channel",
  "community:message.updated": "channel",
  "community:message.edited": "channel",
  "community:reaction.add": "channel",
  "community:reaction.remove": "channel",
  "community:pin.add": "channel",
  "community:pin.remove": "channel",
  "community:typing.start": "channel",
  "community:typing.stop": "channel",
  "community:channel.child_create": "child-create",
  "community:channel.child_update": "child-update",
  "community:channel.create": "channel-create",
  "community:channel.update": "channel",
  "community:unread.bump": "notification",
  "community:mention.create": "mention",
  "community:channel.delete": "control",
  "community:channel.member_remove": "control",
  "community:member.leave": "control",
  "community:server.delete": "control",
  "community:channel.member_add": "control",
  "community:member.join": "control",
  "community:server.update": "control",
  "community:channel.reorder": "control",
  "community:category.create": "control",
  "community:category.update": "control",
  "community:category.delete": "control",
  "community:category.reorder": "control",
  "community:member.update": "control",
  "community:invite.create": "control",
  "community:friend.request": "control",
  "community:friend.accept": "control",
  "community:friend.reject": "control",
  "community:friend.remove": "control",
  "community:friend.block": "control",
  "community:read_state.advanced": "control",
  "community:inbox.changed": "control",
  "community:presence.update": "control",
  "community:status.update": "control",
  "community:identity.update": "control",
  "community:profile.update": "control",
  "community:machine.created": "control",
  "community:machine.status": "control",
  "community:machine.updated": "control",
  "community:machine.removed": "control",
  "community:bot.audit_event": "control",
} as const satisfies Record<CommunityWsEvent["type"], AccessKind>

type Scope = { id: string; serverId?: string; parentChannelId?: string }

export async function canDeliverCommunityContent(
  db: Database,
  targetUserId: string,
  events: readonly CommunityWsEvent[],
): Promise<boolean> {
  const scopes: Scope[] = []
  for (const event of events) {
    const kind = communityContentAccessKinds[event.type]
    if (kind === "control") continue
    switch (event.type) {
      case "community:mention.create": {
        if (event.userId !== targetUserId) return false
        const id = event.channelId ?? await queries.communityChannel.getReadableMessageChannelId(
          db, targetUserId, event.messageId,
        )
        if (!id) return false
        scopes.push({ id })
        break
      }
      case "community:unread.bump":
        if (event.userId !== targetUserId) return false
        scopes.push({ id: event.channelId, serverId: event.serverId })
        break
      case "community:channel.child_create":
        scopes.push({ id: event.parentChannelId }, {
          id: event.channel.id, parentChannelId: event.parentChannelId,
        })
        break
      case "community:channel.child_update":
        scopes.push({ id: event.parentChannelId }, {
          id: event.channelId, parentChannelId: event.parentChannelId,
        })
        break
      case "community:channel.create":
        scopes.push({ id: event.channel.id, serverId: event.serverId })
        break
      case "community:message.create":
      case "community:message.edited":
        scopes.push({ id: event.channelId, serverId: event.serverId,
          parentChannelId: event.parentChannelId })
        break
      case "community:channel.update":
        scopes.push({ id: event.channelId, serverId: event.serverId })
        break
      case "community:message.updated":
      case "community:reaction.add":
      case "community:reaction.remove":
      case "community:pin.add":
      case "community:pin.remove":
      case "community:typing.start":
      case "community:typing.stop":
        scopes.push({ id: event.channelId })
        break
      default:
        return false
    }
  }
  if (scopes.length === 0) return true
  const rows = await queries.communityChannel.listReadableChannelsForUser(
    db, targetUserId, scopes.map((scope) => scope.id),
  )
  const readable = new Map(rows.map((row) => [row.id, row]))
  return scopes.every((scope) => {
    const row = readable.get(scope.id)
    return row !== undefined
      && (scope.serverId === undefined || row.serverId === scope.serverId)
      && (scope.parentChannelId === undefined || row.parentChannelId === scope.parentChannelId)
  })
}
