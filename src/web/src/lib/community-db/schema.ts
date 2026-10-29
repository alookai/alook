import { CommunityChannelResourceSchema, channelLocalSchema, channelSchema, type ChannelRow, type ChannelMembershipRow, type NotificationSettingRow } from "@alook/shared"
export { serverSchema, categorySchema, channelLocalSchema, channelSchema, serverMembershipSchema, channelMembershipSchema, profileSchema, messageSchema, readStateSchema, friendshipSchema, readStateClockSchema, folderSchema, serverRailSchema, folderItemSchema, notificationSettingSchema, communityCollectionSchemas, type CommunityCollectionName, type CommunityCollectionRows, type ServerRow, type CategoryRow, type ChannelRow, type ServerMembershipRow, type ChannelMembershipRow, type ProfileRow, type MessageRow, type FriendshipRow, type ReadStateRow, type ReadStateClockRow, type AttentionScopeRow, type AttentionItemRow, type FolderRow, type FolderItemRow, type NotificationSettingRow } from "@alook/shared"

export function canonicalChannelRow(
  input: Pick<ChannelRow, "id" | "type"> & Partial<Omit<ChannelRow, "id" | "type" | "name">> & { name?: string | null },
  previous?: ChannelRow,
): ChannelRow {
  const fields = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  const resource = CommunityChannelResourceSchema.strip().parse({ ...previous, ...fields })
  const local = channelLocalSchema.partial().strip().parse({ ...previous, ...fields })
  return channelSchema.parse({ ...resource, ...local,
    muted: input.muted ?? previous?.muted ?? false,
    tags: input.tags ?? previous?.tags ?? [],
    pending: input.pending ?? previous?.pending ?? false,
  })
}

export function serverMembershipKey(serverId: string, userId: string) {
  return `${serverId}:${userId}`
}

export function channelMembershipKey(
  channelId: string,
  userId: string,
  relation: ChannelMembershipRow["relation"],
) {
  return `${channelId}:${userId}:${relation}`
}

export function canonicalChannelMembershipRow(
  channelId: string,
  userId: string,
  relation: ChannelMembershipRow["relation"],
  fields: Omit<ChannelMembershipRow, "id" | "channelId" | "userId" | "relation">,
): ChannelMembershipRow {
  return { ...fields, id: channelMembershipKey(channelId, userId, relation), channelId, userId, relation }
}

export function folderItemKey(folderId: string, serverId: string) {
  return `${folderId}:${serverId}`
}

export function notificationSettingKey(
  row: Pick<NotificationSettingRow, "serverId" | "channelId">,
) {
  if (row.channelId) return `channel:${row.channelId}`
  if (row.serverId) return `server:${row.serverId}`
  throw new Error("notification setting target missing")
}
