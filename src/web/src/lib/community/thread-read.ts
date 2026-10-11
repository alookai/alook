import { CommunityResourceProfileSchema, communityReadSchemas, communityChannelResourceFromStorage, normalizeCommunityChannelResource, normalizeCommunityMessageResource, queries, type Database } from "@alook/shared"
import { writeCommunityContractJSON } from "./read-contract"
import { loadApiMessageContext, mapMessageForApi } from "./message-payload"
import { canonicalUserImage } from "./storage"
import { resourceProfile, threadParticipantResources } from "./participant-resources"

type Included = { messages: Array<Parameters<typeof mapMessageForApi>[0] & { channelId: string; replyToId: string | null }>;
  tags: Array<{ messageId: string; tag: string }>;
  participants: Awaited<ReturnType<typeof queries.communityThread.listParticipantsForChannels>> }

export async function writeCommunityThreadsRead(db: Database, userId: string, channel: unknown, threads: unknown[], included?: Included,
  page = { nextCursor: null as string | null, hasMore: false }, contract: 2 | 3 = 2) {
  const normalizeChannel = contract === 3 ? (value: unknown) => communityChannelResourceFromStorage(value) : normalizeCommunityChannelResource
  const parent = normalizeChannel(channel)
  const children = threads.map(normalizeChannel)
  if (children.some((child) => child.parentChannelId !== parent.id || child.serverId !== parent.serverId)) throw new Error("Thread resource scope mismatch")
  const items = included?.messages ?? []
  if (items.some((item) => item.channelId !== parent.id && !children.some((child) => child.id === item.channelId))) throw new Error("Included message scope mismatch")
  const ids = items.map((item) => item.id)
  const scopeIds = [parent.id, ...children.map((child) => child.id)]
  const contextForChannel = await loadApiMessageContext(db, userId, ids, () =>
    queries.communityMessage.getMessagesByIdsInChannels(db, items.flatMap((item) => item.replyToId ? [item.replyToId] : []), scopeIds),
  )
  const messages = items.map((item) => {
    const message = mapMessageForApi(item, contextForChannel(item.channelId), contract, item.channelId)
    return contract === 3 ? message : normalizeCommunityMessageResource(message, item.channelId)
  })
  const participants = threadParticipantResources((included?.participants ?? []).map((row) => ({
    channelId: row.channelId, userId: row.userId, isCreator: children.find((child) => child.id === row.channelId)?.creatorId === row.userId,
    participantCount: "participantCount" in row ? Number(row.participantCount) : undefined,
    profile: resourceProfile({ id: row.userId, name: contract === 3 ? CommunityResourceProfileSchema.shape.name.parse(row.userName) : row.userName ?? "", discriminator: row.discriminator, avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion), avatarVersion: row.userAvatarVersion }),
  })))
  return writeCommunityContractJSON(communityReadSchemas(contract).threads.parse({ contractVersion: contract, channelId: parent.id, channel: parent, threads: children,
    included: { messages, ...participants, profiles: contract === 2 ? participants.profiles.map((profile) => ({ id: profile.id, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, statusEmoji: profile.statusEmoji ?? null, statusText: profile.statusText ?? "" })) : participants.profiles, tags: included?.tags ?? [] }, page }), contract)
}
