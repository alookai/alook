import { CommunityThreadsReadSchema, normalizeCommunityChannelResource, normalizeCommunityMessageResource, queries, type Database } from "@alook/shared"
import { writeCommunityContractJSON } from "./read-contract"
import { groupAttachments, groupReactions } from "./messages"
import { mapMessageForApi } from "./message-payload"
import { canonicalUserImage } from "./storage"

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
  const [attachments, reactions, replies] = await Promise.all([
    queries.communityAttachment.listByMessageIds(db, ids), queries.communityReaction.listReactionsByMessageIds(db, ids, userId),
    queries.communityMessage.getMessagesByIdsInChannels(db, items.flatMap((item) => item.replyToId ? [item.replyToId] : []), scopeIds),
  ])
  const attachmentsByMessage = groupAttachments(attachments), reactionsByMessage = groupReactions(reactions, userId)
  const messages = items.map((item) => normalizeCommunityMessageResource(mapMessageForApi(item, {
    attachmentsByMessage, reactionsByMessage, replyMap: new Map(replies.filter((reply) => reply.channelId === item.channelId).map((reply) => [reply.id, reply])),
  }), item.channelId))
  const participants = included?.participants ?? []
  const profiles = [...new Map(participants.map((row) => [row.userId, { id: row.userId, name: row.userName ?? "", discriminator: null,
    avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion), avatarVersion: row.userAvatarVersion, statusEmoji: null, statusText: "" }])).values()]
  const members = participants.map((row) => ({ channelId: row.channelId, userId: row.userId, relation: "notify", source: "explicit",
    isCreator: children.find((child) => child.id === row.channelId)?.creatorId === row.userId, role: null, memberId: null }))
  return writeCommunityContractJSON(CommunityThreadsReadSchema.parse({ contractVersion: 2, channelId: parent.id, channel: parent, threads: children,
    included: { messages, members, profiles, tags: included?.tags ?? [], participantCounts: [...new Map(participants.map((row) => [row.channelId,
      { channelId: row.channelId, count: "participantCount" in row ? Number(row.participantCount) : participants.filter((member) => member.channelId === row.channelId).length }])).values()] }, page }))
}
