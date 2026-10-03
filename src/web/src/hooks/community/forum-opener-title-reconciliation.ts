"use client"

import type { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, getCanonicalCommunityChannels } from "@/lib/community-db/sync"

export type ForumOpenerTitleIdentity = {
  serverId: string
  forumChannelId: string
  childChannelId: string
  openerMessageId: string
  content: string
}

export async function reconcileForumOpenerTitle(queryClient: QueryClient, identity: ForumOpenerTitleIdentity) {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  try { assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined) } catch { return }
  const child = getCanonicalCommunityChannels(queryClient).find((row) => row.id === identity.childChannelId)
  if (child?.serverId !== identity.serverId
    || child.parentChannelId !== identity.forumChannelId
    || child.parentMessageId !== identity.openerMessageId) return
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: communityKeys.threads(identity.forumChannelId), exact: true }),
    queryClient.invalidateQueries({ queryKey: communityKeys.inboxUnreads(), exact: true }),
  ])
}
