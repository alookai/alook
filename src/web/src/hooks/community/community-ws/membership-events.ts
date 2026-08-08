import type { InfiniteData } from "@tanstack/react-query"
import type {
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  patchCacheJoin,
  patchCacheLeave,
  patchCacheUpdate,
  type MembersEnvelope,
} from "@/hooks/community/use-server-members"
import {
  removeForumSidebarThread,
  removeForumSidebarUnreadChild,
  type ForumSidebarQueryData,
} from "@/hooks/community/use-forum-sidebar-threads"
import { patchAuthorNameInCache, type PageCache } from "@/hooks/community/community-ws/cache"
import type { MembershipEventContext } from "@/hooks/community/community-ws/handler-context"

type ChannelMemberEvent = Extract<
  CommunityWsEvent,
  { type: "community:channel.member_add" | "community:channel.member_remove" }
>

export function handleChannelMemberEvent(
  event: ChannelMemberEvent,
  { queryClient, viewerUserIdRef }: MembershipEventContext,
) {
  // Re-run the viewer-scoped server tree so the sidebar gains/loses the
  // private channel. On REMOVE for the viewer, evict that channel's
  // scoped caches so no private content lingers locally (mirrors the
  // channel.delete eviction above).
  if (
    event.type === "community:channel.member_remove" &&
    event.userId === viewerUserIdRef.current
  ) {
    removeForumSidebarUnreadChild(queryClient, event.serverId, event.channelId)
    useMessageStreamStore.getState().removeScope({
      kind: "channel",
      id: event.channelId,
      serverId: event.serverId,
    })
    queryClient.removeQueries({ queryKey: communityKeys.channelMessages(event.channelId) })
    queryClient.removeQueries({ queryKey: communityKeys.pins(event.channelId) })
    queryClient.removeQueries({ queryKey: communityKeys.threads(event.channelId) })
    queryClient.setQueriesData<ForumSidebarQueryData>(
      { queryKey: communityKeys.forumSidebarThreads(event.serverId) },
      (data) => removeForumSidebarThread(data, event.channelId),
    )
  } else if (
    event.type === "community:channel.member_add" &&
    event.userId === viewerUserIdRef.current
  ) {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.forumSidebarThreads(event.serverId),
    })
  }
  void queryClient.invalidateQueries({ queryKey: communityKeys.server(event.serverId) })
  // Refetch the channel roster so an open private-channel Members drawer
  // (and the manage-members dialog) reflect the add/remove live.
  void queryClient.invalidateQueries({ queryKey: communityKeys.channelMembers(event.channelId) })
  // The addable-members candidate pool is the complement of the roster —
  // a peer's add/remove changes it too, so an open add dialog doesn't
  // offer a just-added member (whose Add would 400) or hide a removed one.
  void queryClient.invalidateQueries({ queryKey: communityKeys.channelAddableMembers(event.channelId) })
  // A forum thread's "Add participant" emits this same MEMBER_ADD event —
  // its Members panel is the participant set, so refetch it too. No-op
  // for a plain channel (participants query disabled there).
  void queryClient.invalidateQueries({ queryKey: communityKeys.threadParticipants(event.channelId) })
}

function finishMemberEvent(
  event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate,
  { queryClient }: MembershipEventContext,
) {
  // Membership just changed → the invite dialog's "friends who aren't
  // in this server" list is stale. Cheap invalidation because the
  // query is disabled unless the dialog is actually open.
  if (event.type !== "community:member.update") {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.invitableFriends(event.serverId),
    })
  }
}

export function handleMemberJoin(
  event: CommunityMemberJoin,
  context: MembershipEventContext,
) {
  const { queryClient } = context
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheJoin(cache, event),
  )
  finishMemberEvent(event, context)
}

export function handleMemberLeave(
  event: CommunityMemberLeave,
  context: MembershipEventContext,
) {
  const { queryClient, viewerUserIdRef } = context
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheLeave(cache, event),
  )
  // If the leaver is the viewer (kick from another tab / owner
  // cascade), the viewer's server rail is stale — invalidate it
  // so the layout's eject effect can detect the drop and route
  // the user away from the now-forbidden URL.
  if (event.userId === viewerUserIdRef.current) {
    useMessageStreamStore.getState().removeServer(event.serverId)
    // Rail LIST only (the layout's eject effect reads it to route the
    // kicked viewer away). `exact` so a kick doesn't cascade-refetch
    // every server's nested detail subtree.
    void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
  }
  finishMemberEvent(event, context)
}

export function handleMemberUpdate(
  event: CommunityMemberUpdate,
  context: MembershipEventContext,
) {
  const { queryClient } = context
  const key = communityKeys.members(event.serverId)
  queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
    key,
    (cache) => patchCacheUpdate(cache, event),
  )
  // A self-rename carries `userId` + `changes.nickname` — patch
  // every cached message list's `authorName` snapshot for that
  // author. A role-only change has no `userId`/`nickname`, so
  // this is a no-op for that case.
  if (event.userId && event.changes.nickname) {
    const userId = event.userId
    const newName = event.changes.nickname
    for (const cacheEntry of queryClient.getQueryCache().findAll({
      predicate: (q) =>
        q.queryKey[0] === "community"
        && (q.queryKey[1] === "channel" || q.queryKey[1] === "dm")
        && q.queryKey[3] === "messages",
    })) {
      queryClient.setQueryData<PageCache | undefined>(
        cacheEntry.queryKey,
        (cache) => patchAuthorNameInCache(cache, userId, newName),
      )
    }
    const streamState = useMessageStreamStore.getState()
    for (const entry of streamState.entries.values()) {
      if (entry.scope.kind === "channel" && entry.scope.serverId !== event.serverId) continue
      for (const message of entry.state.liveById.values()) {
        if (message.authorId !== userId) continue
        useMessageStreamStore.getState().dispatch(entry.scope, {
          type: "liveRefreshed",
          message: { ...message, authorName: newName },
        })
      }
    }
  }
  finishMemberEvent(event, context)
}
