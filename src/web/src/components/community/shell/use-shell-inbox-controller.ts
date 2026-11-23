"use client"
import { completeCommunityPublication } from "@/lib/community-db/sync"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { createElement, useCallback, useRef, type ComponentProps } from "react"
import { channelHref } from "@/lib/community/community-route"
import type { InboxTodo, Marked, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { dmSummaryFromInbox } from "@/lib/community/dm-cache"
import { useInboxAttention, useInboxMarked } from "@/hooks/community/use-inbox"
import { InboxUnreadMessages } from "./inbox-unread-messages"
import { useMarkInboxChannelRead } from "@/hooks/community/use-inbox-channel-messages"
import type { RequestNativeConversationDismissal } from "@/hooks/community/use-native-system-notifications"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import {
  inboxChannelRowTarget,
  inboxDmRowTarget,
  inboxThreadRowTarget,
  terminateThreadOpenerReservationHandoff,
  type InboxRowTarget,
} from "@/hooks/community/inbox-read-reservation"
import {
  useMarkAllInboxRead,
  useAcceptFriendRequest,
  useRejectFriendRequest,
  useReplyInboxChannel,
  useSubmitInboxDecisionCard,
  useDismissInboxTodo,
  useUnmarkMessage,
} from "@/hooks/community/mutations"
import { useFriendRequestActionState } from "@/hooks/community/use-friend-request-action-state"
import type { InboxPopover } from "./community-inbox-popover"
import type { InboxTab } from "./community-inbox-popover"
import type { QueryClient } from "@tanstack/react-query"
import type { ShellRouter } from "./shell-frame-types"
import {
  armThreadOpenerReadHandoff,
  clearThreadOpenerReadHandoff,
} from "@/hooks/community/thread-opener-read-handoff"
import { startConversationNavigationWarmup } from "@/lib/community/conversation-navigation-warmup"
import type { ConversationNavigationTarget } from "@/lib/community/conversation-navigation-warmup"
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
  viewerId: string
  dismissNativeConversation?: RequestNativeConversationDismissal
}

export function useShellInboxController({
  router,
  queryClient,
  cancelPendingNavigation,
  publishedHref,
  navigationPending,
  pendingHref,
  viewerId,
  dismissNativeConversation,
}: Options) {
  const pushInboxHref = useCallback((href: string, prepare?: () => void) => {
    if (router.pushImmediate) router.pushImmediate(href, prepare)
    else { prepare?.(); router.push(href) }
  }, [router])
  const attention = useInboxAttention()
  const unreadFeed = attention.servers
  const unreadDms = attention.dms
  const mentions = attention.mentions
  const todos = attention.todos
  const loading = attention.isLoading
  const [markedTabOpened, setMarkedTabOpened] = useAtom(useCreateAtom(false))
  const [activeTab, setActiveTab] = useAtom(useCreateAtom<InboxTab>("unreads"))
  const scrollOffsetsRef = useRef<Record<InboxTab, number>>({
    unreads: 0,
    todo: 0,
    marked: 0,
  })
  const inboxMarked = useInboxMarked(markedTabOpened)
  const { mutate: unmarkMessageMutate } = useUnmarkMessage()
  const markAllInboxRead = useMarkAllInboxRead()
  const markChannelRead = useMarkInboxChannelRead(dismissNativeConversation)
  const replyInboxChannel = useReplyInboxChannel(dismissNativeConversation)
  const submitInboxDecisionCard = useSubmitInboxDecisionCard()
  const dismissInboxTodo = useDismissInboxTodo()
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
  }, [setActiveTab, setMarkedTabOpened])
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
  })

  const pushProjected = useCallback((
    target: InboxRowTarget,
    destinationHref: string,
    warmup: Omit<ConversationNavigationTarget, "href" | "viewerId">,
    prepare?: () => string | void,
    afterPush?: () => void,
  ) => {
    const epoch = inbox.beginProjection(target, destinationHref)
    cancelPendingNavigation()
    clearThreadOpenerReadHandoff(queryClient)
    let pushedHref = destinationHref
    try {
      pushedHref = prepare?.() ?? destinationHref
      pushInboxHref(pushedHref, () => {
        void startConversationNavigationWarmup(queryClient, {
          ...warmup, href: destinationHref, viewerId,
        })
      })
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
  }, [cancelPendingNavigation, inbox, pushInboxHref, queryClient, viewerId])

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
        pushInboxHref(href, () => {
          void startConversationNavigationWarmup(queryClient, {
            href,
            viewerId,
            channelId: channel.channelId,
            serverId: server.serverId,
            scopeKind: "channel",
            expectedSurfaceKind: channel.type === "forum" ? "forum" : "channel",
          })
        })
      } catch (error) {
          cancelPendingNavigation()
        inbox.onOpenChange(previousOpen)
        throw error
      }
      return
    }
    pushProjected(target, href, {
      channelId: channel.channelId,
      serverId: server.serverId,
      scopeKind: "channel",
      expectedSurfaceKind: channel.type === "forum" ? "forum" : "channel",
    })
  }, [cancelPendingNavigation, inbox, pushInboxHref, pushProjected, queryClient, viewerId])

  const openThread = useCallback((
    server: UnreadServer,
    parent: UnreadChannel,
    child: UnreadChild,
  ) => {
    const target = inboxThreadRowTarget(server, parent, child)
    const href = channelHref(server.serverId, child.channelId)
    pushProjected(target, href, {
      channelId: child.channelId,
      serverId: server.serverId,
      scopeKind: "channel",
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
    const seq = marked.m.seq != null ? `seq=${marked.m.seq}` : ""
    const seqQuery = marked.serverId ? `?${seq ? `${seq}&` : ""}msg=${encodeURIComponent(marked.m.id)}` : seq ? `?${seq}` : ""
    const href = marked.serverId
      ? `${channelHref(marked.serverId, marked.channelId)}${seqQuery}`
      : `/c/me/${marked.channelId}${seqQuery}`
    try {
      pushInboxHref(href, () => {
        void startConversationNavigationWarmup(queryClient, {
          href,
          viewerId,
          channelId: marked.channelId,
          ...(marked.serverId ? { serverId: marked.serverId } : {}),
          scopeKind: marked.serverId ? "channel" : "dm",
          ...(marked.serverId ? { anchorMessageId: marked.m.id } : {}),
          ...(!marked.serverId ? { expectedSurfaceKind: "dm" as const } : {}),
        })
      })
    } catch (error) {
      cancelPendingNavigation()
      inbox.onOpenChange(previousOpen)
      throw error
    }
  }, [cancelPendingNavigation, inbox, pushInboxHref, queryClient, viewerId])

  const openDm = useCallback((dm: UnreadDm) => {
    const dmId = dm.channelId
    pushProjected(
      inboxDmRowTarget(dm),
      `/c/me/${dmId}`,
      {
        channelId: dmId,
        scopeKind: "dm",
        expectedSurfaceKind: "dm",
      },
      () => {
        const summary = dmSummaryFromInbox(dm)
        void Promise.resolve(completeCommunityPublication(queryClient, () => publishCommunityDmSummary(queryClient, summary))).catch(() => undefined)
      },
    )
  }, [pushProjected, queryClient])

  const openTodo = useCallback((todo: InboxTodo) => {
    const previousOpen = inbox.closeWithoutProjection()
    cancelPendingNavigation()
    clearThreadOpenerReadHandoff(queryClient)
    const seq = todo.m.seq != null ? `seq=${todo.m.seq}` : ""
    const seqQuery = todo.serverId ? `?${seq ? `${seq}&` : ""}msg=${encodeURIComponent(todo.messageId)}` : seq ? `?${seq}` : ""
    const href = todo.serverId
      ? `${channelHref(todo.serverId, todo.channelId)}${seqQuery}`
      : `/c/me/${todo.channelId}${seqQuery}`
    try {
      pushInboxHref(href, () => {
        void startConversationNavigationWarmup(queryClient, {
          href,
          viewerId,
          channelId: todo.channelId,
          ...(todo.serverId ? { serverId: todo.serverId } : {}),
          scopeKind: todo.serverId ? "channel" : "dm",
          ...(todo.serverId ? { anchorMessageId: todo.messageId } : {}),
          ...(!todo.serverId ? { expectedSurfaceKind: "dm" as const } : {}),
        })
      })
    } catch (error) {
      cancelPendingNavigation()
      inbox.onOpenChange(previousOpen)
      throw error
    }
  }, [cancelPendingNavigation, inbox, pushInboxHref, queryClient, viewerId])

  const submitTodo = useCallback((todo: InboxTodo, content: string, nonce: string) => (
    submitInboxDecisionCard.mutateAsync({
      channelId: todo.channelId,
      messageId: todo.messageId,
      content,
      nonce,
    })
  ), [submitInboxDecisionCard])

  const replyTodo = useCallback((todo: InboxTodo, content: string, nonce: string) => (
    submitInboxDecisionCard.mutateAsync({
      channelId: todo.channelId,
      messageId: todo.messageId,
      content,
      nonce,
      toastMessage: "Reply sent",
    })
  ), [submitInboxDecisionCard])

  const submitUnreadDecisionCard = useCallback((channelId: string, messageId: string, content: string, nonce: string) => (
    submitInboxDecisionCard.mutateAsync({
      channelId,
      messageId,
      content,
      nonce,
    })
  ), [submitInboxDecisionCard])

  const replyChannel = useCallback((channelId: string, content: string, nonce: string) => (
    replyInboxChannel.mutateAsync({
      channelId,
      content,
      nonce,
    })
  ), [replyInboxChannel])

  const dismissTodo = useCallback((todo: InboxTodo) => {
    dismissInboxTodo.mutate({ messageId: todo.messageId })
  }, [dismissInboxTodo])

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
    todos,
    todosTruncated: attention.todosTruncated,
    marked: inboxMarked.marked,
    markedLoading: !inboxMarked.isDisplayReady && !inboxMarked.isInitialError,
    markedError: inboxMarked.isInitialError,
    markedRetrying: inboxMarked.isFetching,
    onRetryMarked: () => { void inboxMarked.refetch() },
    loading,
    attentionError: attention.isInitialError,
    attentionRetrying: attention.isFetching,
    onRetryAttention: () => { void attention.refetch() },
    hasProjectedUnreads: attention.hasUnread,
    hasProjectedMentions: attention.hasMention,
    viewerUserId: viewerId,
    onOpenChannel: openServerChannel,
    onOpenThread: openThread,
    onOpenDm: openDm,
    onOpenTodo: openTodo,
    onSubmitTodo: submitTodo,
    onReplyTodo: replyTodo,
    onDismissTodo: dismissTodo,
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
    onMarkChannelRead: (channelId, throughSeq) => markChannelRead.mutateAsync({ channelId, throughSeq }),
    onReplyChannel: replyChannel,
    onSubmitDecisionCard: submitUnreadDecisionCard,
    channelReadActions: markChannelRead.actions,
    renderUnreadMessages: (input) => createElement(InboxUnreadMessages, input),
    onUnmark: (messageId) => unmarkMessageMutate({ messageId }),
  }
  const unreadCount = attention.exactAttentionCount

  return {
    popoverProps,
    unreadCount,
    unreadCountPartial: attention.todosTruncated,
    hasUnread: unreadCount > 0,
    open: inbox.open,
    onOpenChange: inbox.onOpenChange,
  }
}
