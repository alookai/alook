import { CommunityMembersReadSchema, queries, type Database } from "@alook/shared"
import { requireMessageSurfaceAccess } from "./permissions"
import { writeError } from "@/lib/middleware/helpers"
import { writeCommunityContractJSON } from "./read-contract"
import { canonicalUserImage } from "./storage"

export async function readCommunityMembers(db: Database, channelId: string, userId: string, relation: string | null) {
  const access = await requireMessageSurfaceAccess(db, channelId, userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (relation !== "access" && relation !== "notify") return writeError("relation must be access or notify", 400)
  const channel = access.value.surface === "channel" ? access.value.channel
    : await queries.communityChannel.getChannelForMember(db, channelId, userId)
  if (!channel) return writeError("not found", 404)
  const relations = relation === "notify"
    ? (await queries.communityThread.listThreadParticipants(db, channelId)).map((row) => ({ userId: row.userId, source: row.source }))
    : access.value.surface === "dm"
      ? (await queries.communityChannel.listChannelMemberUserIds(db, channelId)).map((id) => ({ userId: id, source: "explicit" }))
      : await queries.communityMembersResolver.resolveScopeMembers(db, { scope: channel.type === "forum" ? "forum" : "channel", scopeId: channelId })
  const ids = relations.map((row) => row.userId)
  const [users, serverMembers] = await Promise.all([
    queries.user.getUsersByIds(db, ids), channel.serverId
      ? queries.communityMember.getMembersByUserIds(db, channel.serverId, ids) : Promise.resolve([]),
  ])
  const memberByUser = new Map(serverMembers.map((row) => [row.userId, row]))
  const profiles = users.map((row) => ({ id: row.id, name: row.name ?? "", discriminator: row.discriminator ?? null,
    avatar: canonicalUserImage(row.id, row.image, row.avatarVersion), avatarVersion: row.avatarVersion,
    statusEmoji: memberByUser.get(row.id)?.statusEmoji ?? null, statusText: memberByUser.get(row.id)?.statusText ?? "" }))
  const available = new Set(profiles.map((profile) => profile.id))
  return writeCommunityContractJSON(CommunityMembersReadSchema.parse({ contractVersion: 2, channelId, relation,
    members: relations.filter((row) => available.has(row.userId)).map((row) => ({ channelId, userId: row.userId,
      relation, source: row.source ?? "explicit", isCreator: row.userId === channel.creatorId,
      role: memberByUser.get(row.userId)?.role ?? null, memberId: memberByUser.get(row.userId)?.id ?? null })), profiles }))
}
