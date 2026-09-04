type FeedThread = {
  id: string
  name: string | null
  creatorId: string | null
  messageCount: number | null
  parentMessageId: string | null
  lastMessageAt: string | null
  createdAt: string
  activityAt: string
}

type IncludedMessage = {
  id: string
  channelId: string
  seq: number
  createdAt?: string
  content: string
  authorId: string
  authorName: string
  authorImage: string | null
  authorAvatarVersion: number
}

type IncludedFirstMessage = { channelId: string; content: string }
type IncludedTag = { messageId: string; tag: string }
type IncludedParticipant = {
  channelId: string
  userId: string
  userName: string | null
  userImage: string | null
  userAvatarVersion: number
  participantCount?: number
}

export type ForumFeedPage = {
  serverId: string
  parentType: string
  threads: FeedThread[]
  included: {
    parentMessages: IncludedMessage[]
    firstMessages: IncludedFirstMessage[]
    tags: IncludedTag[]
    participants: IncludedParticipant[]
  }
  hasMore: boolean
  nextCursor?: string
}
