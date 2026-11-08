import type { UnreadDm } from "./models/inbox"
import type { DM } from "./models/people"


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
