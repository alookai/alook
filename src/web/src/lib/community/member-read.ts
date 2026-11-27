import { COMMUNITY_CONTRACT_VERSION, type CommunityContract, CommunityResourceProfileSchema, communityReadSchemas, queries, type Database } from "@alook/shared"
import { requireMessageSurfaceAccess } from "./permissions"
import { writeError } from "@/lib/middleware/helpers"
import { writeCommunityContractJSON } from "./read-contract"
import { canonicalUserImage } from "./storage"
import { resourceProfile } from "./participant-resources"

const DEFAULT_CHANNEL_MEMBERS_LIMIT = 200
const MAX_CHANNEL_MEMBERS_LIMIT = 200

export async function readCommunityMembers(
  db: Database,
  channelId: string,
  userId: string,
  relation: string | null,
  contract: CommunityContract = COMMUNITY_CONTRACT_VERSION,
  pagination?: { limit?: number; cursor?: string },
) {
  const access = await requireMessageSurfaceAccess(db, channelId, userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (relation !== "access" && relation !== "notify") return writeError("relation must be access or notify", 400)
  const channel = access.value.surface === "channel" ? access.value.channel
    : await queries.communityChannel.getChannelForMember(db, channelId, userId)
  if (!channel) return writeError("not found", 404)

  const limit = Math.max(1, Math.min(pagination?.limit ?? DEFAULT_CHANNEL_MEMBERS_LIMIT, MAX_CHANNEL_MEMBERS_LIMIT))
  const pageOpts = pagination
    ? { limit: limit + 1, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) }
    : undefined

  let rawRelations = relation === "notify"
    ? (pageOpts
        ? await queries.communityThread.listThreadParticipants(db, channelId, pageOpts)
        : await queries.communityThread.listThreadParticipants(db, channelId)
      ).map((row) => ({ userId: row.userId, source: row.source }))
    : access.value.surface === "dm"
      ? (await queries.communityChannel.listChannelMemberUserIds(db, channelId)).map((id) => ({ userId: id, source: "explicit" }))
      : pageOpts
        ? await queries.communityMembersResolver.resolveScopeMembers(db, channelId, pageOpts)
        : await queries.communityMembersResolver.resolveScopeMembers(db, channelId)

  if (access.value.surface === "dm" && pagination?.cursor) {
    const cursor = pagination.cursor
    rawRelations = [...rawRelations].sort((a, b) => a.userId.localeCompare(b.userId)).filter((row) => row.userId > cursor)
  }

  const hasMore = rawRelations.length > limit
  const relations = hasMore ? rawRelations.slice(0, limit) : rawRelations
  const nextCursor = hasMore && relations.length > 0 ? relations[relations.length - 1]!.userId : null

  const ids = relations.map((row) => row.userId)
  const [users, serverMembers] = await Promise.all([
    queries.user.getUsersByIds(db, ids), channel.serverId
      ? queries.communityMember.getMembersByUserIds(db, channel.serverId, ids) : Promise.resolve([]),
  ])
  const memberByUser = new Map(serverMembers.map((row) => [row.userId, row]))
  const profiles = users.map((row) => resourceProfile({ id: row.id, name: CommunityResourceProfileSchema.shape.name.parse(row.name), discriminator: row.discriminator,
    avatar: canonicalUserImage(row.id, row.image, row.avatarVersion), avatarVersion: row.avatarVersion,
    ...(memberByUser.has(row.id) ? {
      statusEmoji: memberByUser.get(row.id)!.statusEmoji, statusText: memberByUser.get(row.id)!.statusText,
    } : {}) }))
  const available = new Set(profiles.map((profile) => profile.id))
  return writeCommunityContractJSON(communityReadSchemas(contract).members.parse({
    contractVersion: contract,
    channelId,
    relation,
    members: relations.filter((row) => available.has(row.userId)).map((row) => ({
      channelId,
      userId: row.userId,
      relation,
      source: row.source ?? "explicit",
      isCreator: row.userId === channel.creatorId,
      role: memberByUser.get(row.userId)?.role ?? null,
      memberId: memberByUser.get(row.userId)?.id ?? null,
    })),
    profiles,
    ...(pagination || hasMore ? { page: { hasMore, nextCursor } } : {}),
  }), contract)
}
