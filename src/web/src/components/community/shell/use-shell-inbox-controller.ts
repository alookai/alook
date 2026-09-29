"use client"

import { useCallback, useRef, useState, type ComponentProps } from "react"
import { communityKeys } from "@/lib/query-keys"
import { channelHref } from "@/lib/community/community-route"
import type { Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { dmSummaryFromInbox, upsertDmSummary, type DmCache } from "@/lib/community/dm-cache"
import { useInboxAttention, useInboxMarked } from "@/hooks/community/use-inbox"
import { startDmRouteVerification } from "@/hooks/community/use-dm-route-verification"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import {
  inboxChannelRowTarget,
  inboxDmRowTarget,
  inboxMentionRowTarget,
  inboxThreadRowTarget,
  terminateThreadOpenerReservationHandoff,
  type InboxRowTarget,
} from "@/hooks/community/inbox-read-reservation"
import {
  useMarkAllInboxRead,
  useAcceptFriendRequest,
  useRejectFriendRequest,
  useDeleteMention,
  useUnmarkMessage,
} from "@/hooks/community/mutations"
import { useFriendRequestActionState } from "@/hooks/community/use-friend-request-action-state"
import type { InboxPopover } from "./community-inbox-popover"
import type { InboxTab } from "./community-inbox-popover"
import type { QueryClient } from "@tanstack/react-query"
import type { ShellNavigationOptions, ShellRouter } from "./shell-frame-types"
import {
  armThreadOpenerReadHandoff,
  clearThreadOpenerReadHandoff,
} from "@/hooks/community/thread-opener-read-handoff"
import { publishCommunityDmSummary } from "@/lib/community-db/sync"

type UnreadChannel = UnreadServer["channels"][number]
type UnreadChild = UnreadChannel["children"][number]

type Options = {
  router: ShellRouter
  queryClient: QueryClient
  cancelPendingNavigation: () => void
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
}

export function useShellInboxController({
  router,
  queryClient,
  cancelPendingNavigation,
  publishedHref,
  navigationPending,
  pendingHref,
}: Options) {
  const pushInboxHref = useCallback((href: string, options?: ShellNavigationOptions) => {
    router.push(href, options)
  }, [router])
  const attention = useInboxAttention()
  const unreadFeed = attention.servers
  const unreadDms = attention.dms
  const mentions = attention.mentions
  const loading = attention.isLoading
  const [markedTabOpened, setMarkedTabOpened] = useState(false)
  const [activeTab, setActiveTab] = useState<InboxTab>("unreads")
  const scrollOffsetsRef = useRef<Record<InboxTab, number>>({
    unreads: 0,
    mentions: 0,
    marked: 0,
  })
  const inboxMarked = useInboxMarked(markedTabOpened)
  const { mutate: unmarkMessageMutate } = useUnmarkMessage()
  const markAllInboxRead = useMarkAllInboxRead()
  const deleteMention = useDeleteMention()
  const acceptFriendRequest = useAcceptFriendRequest()
  const rejectFriendRequest = useRejectFriendRequest()
  const inbox = useInboxAutoCollapse({
    queryClient,
    publishedHref,
    navigationPending,
    pendingHref,
  })
  const changeActiveTab = useCallback((tab: InboxTab) => {
    setActiveTab(tab)
    if (tab === "marked") setMarkedTabOpened(true)
  }, [])
  const getScrollOffset = useCallback((tab: InboxTab) => (
    scrollOffsetsRef.current[tab]
  ), [])
  const setScrollOffset = useCallback((tab: InboxTab, scrollTop: number) => {
    scrollOffsetsRef.current[tab] = scrollTop
  }, [])
  const acceptRequest = useCallback(
    (friendshipId: string) => acceptFriendRequest.mutateAsync({ friendshipId }),
    [acceptFriendRequest],
  )
  const rejectRequest = useCallback(
    (friendshipId: string) => rejectFriendRequest.mutateAsync({ friendshipId }),
    [rejectFriendRequest],
  )
  const friendRequestActions = useFriendRequestActionState({
    rows: attention.friendRequests,
    onAccept: acceptRequest,
    onReject: rejectRequest,
    surface: "inbox",
  })

  const pushProjected = useCallback((
    target: InboxRowTarget,
    destinationHref: string,
    navigationOptions?: ShellNavigationOptions,
    prepare?: () => string | void,
    afterPush?: () => void,
  ) => {
    const epoch = inbox.beginProjection(target, destinationHref)
    cancelPendingNavigation()
    clearThreadOpenerReadHandoff(queryClient)
    let pushedHref = destinationHref
    try {
      pushedHref = prepare?.() ?? destinationHref
      pushInboxHref(pushedHref, navigationOptions)
      if (inbox.markProjectionSubmitted(epoch)) afterPush?.()
    } catch (error) {
      const nonce = new URLSearchParams(pushedHref.split("?")[1] ?? "")
        .get("inboxThreadOpener")
      if (nonce) terminateThreadOpenerReservationHandoff(queryClient, nonce)
      if (inbox.isLatestProjection(epoch)) {
        cancelPendingNavigation()
        inbox.rollbackProjection(epoch, true)
      }
      throw error
    }
  }, [cancelPendingNavigation, inbox, pushInboxHref, queryClient])

  const openServerChannel = useCallback((
    server: UnreadServer,
    channel: UnreadChannel,
    directUnreadVisible: boolean,
  ) => {
    const href = channelHref(server.serverId, channel.channelId)
    const target = directUnreadVisible
      ? inboxChannelRowTarget(server, channel)
      : null
    if (!target) {
      const previousOpen = inbox.closeWithoutProjection()
      cancelPendingNavigation()
      clearThreadOpenerReadHandoff(queryClient)
      try {
        pushInboxHref(href, {
          expectedSurfaceKind: channel.type === "forum" ? "forum" : "channel",
        })
      } catch (error) {
        cancelPendingNavigation()
        inbox.onOpenChange(previousOpen)
        throw error
      }
      return
    }
    pushProjected(target, href, {
      expectedSurfaceKind: channel.type === "forum" ? "forum" : "channel",
    })
  }, [cancelPendingNavigation, inbox, pushInboxHref, pushProjected, queryClient])

  const openThread = useCallback((
    server: UnreadServer,
    parent: UnreadChannel,
    child: UnreadChild,
  ) => {
    const target = inboxThreadRowTarget(server, parent, child)
    const href = channelHref(server.serverId, child.channelId)
    pushProjected(target, href, {
      expectedSurfaceKind: "thread",
    }, () => (
      child.openerMessageId
      && child.openerUnread === true
      && child.openerSeq !== undefined
        ? armThreadOpenerReadHandoff(queryClient, {
            serverId: server.serverId,
            parentChannelId: child.parentChannelId ?? parent.channelId,
            childChannelId: child.channelId,
            openerMessageId: child.openerMessageId,
            openerSeq: child.openerSeq,
          })
        : href
    ))
  }, [pushProjected, queryClient])

  const openMarked = useCallback((marked: Marked) => {
    const previousOpen = inbox.closeWithoutProjection()
    cancelPendingNavigation()
    clearThreadOpenerReadHandoff(queryClient)
    const seqQuery = marked.m.seq != null ? `?seq=${marked.m.seq}` : ""
    const href = marked.serverId
      ? `${channelHref(marked.serverId, marked.channelId)}${seqQuery}`
      : `/c/me/${marked.channelId}${seqQuery}`
    try {
      pushInboxHref(href, {
        anchorMessageId: marked.m.id,
        ...(!marked.serverId ? { expectedSurfaceKind: "dm" as const } : {}),
      })
    } catch (error) {
      cancelPendingNavigation()
      inbox.onOpenChange(previousOpen)
      throw error
    }
  }, [cancelPendingNavigation, inbox, pushInboxHref, queryClient])

  const openDm = useCallback((dm: UnreadDm) => {
    const dmId = dm.channelId
    pushProjected(
      inboxDmRowTarget(dm),
      `/c/me/${dmId}`,
      { expectedSurfaceKind: "dm" },
      () => {
        const summary = dmSummaryFromInbox(dm)
        queryClient.setQueryData(
          communityKeys.dms(),
          (previous: DmCache | undefined) => (
            upsertDmSummary(previous, summary)
          ),
        )
        publishCommunityDmSummary(queryClient, summary)
      },
      () => {
        void startDmRouteVerification(queryClient, dmId).catch(() => undefined)
      },
    )
  }, [pushProjected, queryClient])

  const openMention = useCallback((mention: Mention) => {
    const target = inboxMentionRowTarget(mention)
    if (!target || !mention.serverId || !mention.channelId) return
    const href = `${channelHref(mention.serverId, mention.channelId)}?msg=${mention.m.id}`
    pushProjected(target, href, { anchorMessageId: mention.m.id })
  }, [pushProjected])

  const openFriendRequests = useCallback(() => {
    const previousOpen = inbox.closeWithoutProjection()
    cancelPendingNavigation()
    try {
      pushInboxHref("/c/me/friends?tab=new")
    } catch (error) {
      cancelPendingNavigation()
      inbox.onOpenChange(previousOpen)
      throw error
    }
  }, [cancelPendingNavigation, inbox, pushInboxHref])

  const popoverProps: ComponentProps<typeof InboxPopover> = {
    friendRequests: friendRequestActions.items,
    unreads: unreadFeed,
    unreadDms,
    mentions,
    marked: inboxMarked.marked,
    markedLoading: inboxMarked.isLoading,
    loading,
    attentionError: attention.isInitialError,
    onRetryAttention: () => { void attention.refetch() },
    hasProjectedUnreads: attention.hasUnread,
    hasProjectedMentions: attention.hasMention,
    onOpenChannel: openServerChannel,
    onOpenThread: openThread,
    onOpenDm: openDm,
    onOpenMention: openMention,
    onOpenMarked: openMarked,
    onOpenFriendRequests: openFriendRequests,
    onAcceptFriendRequest: (item) => { void friendRequestActions.act(item, "accept") },
    onRejectFriendRequest: (item) => { void friendRequestActions.act(item, "reject") },
    onRetryFriendRequest: (item) => { void friendRequestActions.retry(item) },
    activeTab,
    onActiveTabChange: changeActiveTab,
    onMarkedTabSelected: () => setMarkedTabOpened(true),
    getScrollOffset,
    onScrollOffsetChange: setScrollOffset,
    onMarkAllRead: () => { markAllInboxRead.mutate() },
    onDeleteMention: (id) => deleteMention.mutate({ mentionId: id }),
    onUnmark: (messageId) => unmarkMessageMutate({ messageId }),
  }
  const unreadCount = attention.exactAttentionCount

  return {
    popoverProps,
    unreadCount,
    unreadCountPartial: false,
    hasUnread: unreadCount > 0,
    open: inbox.open,
    onOpenChange: inbox.onOpenChange,
  }
}
