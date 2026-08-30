"use client"

import { useCallback, useRef, useState, type ComponentProps } from "react"
import { communityKeys } from "@/lib/query-keys"
import { channelHref } from "@/lib/community/community-route"
import type { Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { dmSummaryFromInbox, upsertDmSummary, type DmCache } from "@/lib/community/dm-cache"
import { useInboxUnreads, useInboxMentions, useInboxMarked } from "@/hooks/community/use-inbox"
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
  useDeleteMention,
  useUnmarkMessage,
} from "@/hooks/community/mutations"
import type { InboxPopover } from "./community-inbox-popover"
import type { InboxTab } from "./community-inbox-popover"
import type { QueryClient } from "@tanstack/react-query"
import type { ShellRouter } from "./shell-frame-types"
import {
  armThreadOpenerReadHandoff,
  clearThreadOpenerReadHandoff,
} from "@/hooks/community/thread-opener-read-handoff"

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
  const inboxUnreads = useInboxUnreads()
  const inboxMentions = useInboxMentions()
  const unreadFeed = inboxUnreads.servers
  const unreadDms = inboxUnreads.dms
  const mentions = inboxMentions.mentions
  const loading = inboxUnreads.isLoading || inboxMentions.isLoading
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

  const pushProjected = useCallback((
    target: InboxRowTarget,
    destinationHref: string,
    prepare?: () => string | void,
    afterPush?: () => void,
  ) => {
    const epoch = inbox.beginProjection(target, destinationHref)
    cancelPendingNavigation()
    clearThreadOpenerReadHandoff(queryClient)
    let pushedHref = destinationHref
    try {
      pushedHref = prepare?.() ?? destinationHref
      router.push(pushedHref)
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
  }, [cancelPendingNavigation, inbox, queryClient, router])

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
        router.push(href)
      } catch (error) {
        cancelPendingNavigation()
        inbox.onOpenChange(previousOpen)
        throw error
      }
      return
    }
    pushProjected(target, href)
  }, [cancelPendingNavigation, inbox, pushProjected, queryClient, router])

  const openThread = useCallback((
    server: UnreadServer,
    parent: UnreadChannel,
    child: UnreadChild,
  ) => {
    const target = inboxThreadRowTarget(server, parent, child)
    const href = channelHref(server.serverId, child.channelId)
    pushProjected(target, href, () => (
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
      router.push(href)
    } catch (error) {
      cancelPendingNavigation()
      inbox.onOpenChange(previousOpen)
      throw error
    }
  }, [cancelPendingNavigation, inbox, queryClient, router])

  const openDm = useCallback((dm: UnreadDm) => {
    const dmId = dm.channelId
    pushProjected(
      inboxDmRowTarget(dm),
      `/c/me/${dmId}`,
      () => {
        queryClient.setQueryData(
          communityKeys.dms(),
          (previous: DmCache | undefined) => (
            upsertDmSummary(previous, dmSummaryFromInbox(dm))
          ),
        )
      },
      () => {
        void startDmRouteVerification(queryClient, dmId).catch(() => undefined)
      },
    )
  }, [pushProjected, queryClient])

  const openMention = useCallback((mention: Mention) => {
    const target = inboxMentionRowTarget(mention)
    if (!target || !mention.serverId || !mention.channelId) return
    pushProjected(target, channelHref(mention.serverId, mention.channelId))
  }, [pushProjected])

  const popoverProps: ComponentProps<typeof InboxPopover> = {
    unreads: unreadFeed,
    unreadDms,
    mentions,
    marked: inboxMarked.marked,
    markedLoading: inboxMarked.isLoading,
    loading,
    hasProjectedUnreads: inboxUnreads.hasProjectedUnread,
    hasProjectedMentions: inboxMentions.hasProjectedMention,
    onOpenChannel: openServerChannel,
    onOpenThread: openThread,
    onOpenDm: openDm,
    onOpenMention: openMention,
    onOpenMarked: openMarked,
    activeTab,
    onActiveTabChange: changeActiveTab,
    onMarkedTabSelected: () => setMarkedTabOpened(true),
    getScrollOffset,
    onScrollOffsetChange: setScrollOffset,
    onMarkAllRead: () => { markAllInboxRead.mutate() },
    onDeleteMention: (id) => deleteMention.mutate({ mentionId: id }),
    onUnmark: (messageId) => unmarkMessageMutate({ messageId }),
    isProjected: inbox.isProjected,
  }

  return {
    popoverProps,
    hasUnread:
      inboxUnreads.hasProjectedUnread || inboxMentions.hasProjectedMention,
    open: inbox.open,
    onOpenChange: inbox.onOpenChange,
  }
}
