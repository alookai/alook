import type { UnreadDm } from "./models/inbox"
import type { DM } from "./models/people"
import { sortDmsByActivity } from "./dm-order"

export type DmCache = { conversations: DM[] }

export function dmSummaryFromInbox(unread: UnreadDm): DM {
  return {
    id: unread.channelId,
    userId: unread.otherUserId,
    name: unread.otherUserName,
    discriminator: unread.otherUserDiscriminator,
    avatar: unread.otherUserAvatar,
    avatarVersion: unread.otherUserAvatarVersion,
    status: "offline",
    preview: "",
    activityAt: unread.lastMessageAt,
    unread: false,
  }
}

export function upsertDmSummary(
  previous: DmCache | undefined,
  incoming: DM,
): DmCache {
  if (!previous) return { conversations: [incoming] }
  const existingIndex = previous.conversations.findIndex((dm) => dm.id === incoming.id)
  if (existingIndex < 0) {
    return { ...previous, conversations: sortDmsByActivity([incoming, ...previous.conversations]) }
  }
  return {
    ...previous,
    conversations: sortDmsByActivity(previous.conversations.map((dm, index) =>
      index === existingIndex
        ? {
          ...dm,
          ...incoming,
          status: dm.status,
          preview: dm.preview,
        }
        : dm
    )),
  }
}
