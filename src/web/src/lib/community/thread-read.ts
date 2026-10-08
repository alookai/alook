import { CommunityThreadsReadSchema, normalizeCommunityChannelResource, normalizeCommunityMessageResource, queries, type Database } from "@alook/shared"
import { writeCommunityContractJSON } from "./read-contract"
import { loadApiMessageContext, mapMessageForApi } from "./message-payload"
import { canonicalUserImage } from "./storage"
import { resourceProfile, threadParticipantResources } from "./participant-resources"

type Included = { messages: Array<Parameters<typeof mapMessageForApi>[0] & { channelId: string; replyToId: string | null }>;
  tags: Array<{ messageId: string; tag: string }>;
  participants: Awaited<ReturnType<typeof queries.communityThread.listParticipantsForChannels>> }

export async function writeCommunityThreadsRead(db: Database, userId: string, channel: unknown, threads: unknown[], included?: Included,
  page = { nextCursor: null as string | null, hasMore: false }) {
  const parent = normalizeCommunityChannelResource(channel)
  const children = threads.map(normalizeCommunityChannelResource)
  if (children.some((child) => child.parentChannelId !== parent.id || child.serverId !== parent.serverId)) throw new Error("Thread resource scope mismatch")
  const items = included?.messages ?? []
  if (items.some((item) => item.channelId !== parent.id && !children.some((child) => child.id === item.channelId))) throw new Error("Included message scope mismatch")
  const ids = items.map((item) => item.id)
  const scopeIds = [parent.id, ...children.map((child) => child.id)]
  const contextForChannel = await loadApiMessageContext(db, userId, ids, () =>
    queries.communityMessage.getMessagesByIdsInChannels(db, items.flatMap((item) => item.replyToId ? [item.replyToId] : []), scopeIds),
  )
  const messages = items.map((item) => normalizeCommunityMessageResource(mapMessageForApi(item, contextForChannel(item.channelId)), item.channelId))
  const participants = threadParticipantResources((included?.participants ?? []).map((row) => ({
    channelId: row.channelId, userId: row.userId, isCreator: children.find((child) => child.id === row.channelId)?.creatorId === row.userId,
    participantCount: "participantCount" in row ? Number(row.participantCount) : undefined,
    profile: resourceProfile({ id: row.userId, name: row.userName ?? "", avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion), avatarVersion: row.userAvatarVersion }),
  })))
  return writeCommunityContractJSON(CommunityThreadsReadSchema.parse({ contractVersion: 2, channelId: parent.id, channel: parent, threads: children,
    included: { messages, ...participants, tags: included?.tags ?? [] }, page }))
}
