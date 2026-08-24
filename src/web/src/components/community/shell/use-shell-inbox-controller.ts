"use client"

import { useCallback, useState, type ComponentProps } from "react"
import { communityKeys } from "@/lib/query-keys"
import { channelHref } from "@/lib/community/community-route"
import type { Marked, UnreadDm } from "@/lib/community/models/inbox"
import { dmSummaryFromInbox, upsertDmSummary, type DmCache } from "@/lib/community/dm-cache"
import { useInboxUnreads, useInboxMentions, useInboxMarked } from "@/hooks/community/use-inbox"
import { startDmRouteVerification } from "@/hooks/community/use-dm-route-verification"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import {
  useMarkAllInboxRead,
  useDeleteMention,
  useUnmarkMessage,
} from "@/hooks/community/mutations"
import type { InboxPopover } from "./community-inbox-popover"
import type { QueryClient } from "@tanstack/react-query"
import type { ShellRouter } from "./shell-frame-types"

type Options = {
  router: ShellRouter
  queryClient: QueryClient
  cancelPendingNavigation: () => void
}

export function useShellInboxController({
  router,
  queryClient,
  cancelPendingNavigation,
}: Options) {
  const inboxUnreads = useInboxUnreads()
  const inboxMentions = useInboxMentions()
  const unreadFeed = inboxUnreads.servers
  const unreadDms = inboxUnreads.dms
  const mentions = inboxMentions.mentions
  const loading = inboxUnreads.isLoading || inboxMentions.isLoading
  const [markedTabOpened, setMarkedTabOpened] = useState(false)
  const inboxMarked = useInboxMarked(markedTabOpened)
  const { mutate: unmarkMessageMutate } = useUnmarkMessage()
  const markAllInboxRead = useMarkAllInboxRead()
  const deleteMention = useDeleteMention()
  const inbox = useInboxAutoCollapse({ unreads: unreadFeed, unreadDms, mentions })
  const watchInboxItem = inbox.watchItem

  const openServerChannel = useCallback((
    serverId: string,
    channelId: string,
    _parentChannelId?: string,
    watchKey: string = `channel:${channelId}`,
  ) => {
    watchInboxItem(watchKey)
    cancelPendingNavigation()
    router.push(channelHref(serverId, channelId))
  }, [cancelPendingNavigation, router, watchInboxItem])

  const openForumThread = useCallback((
    serverId: string,
    parentChannelId: string,
    childChannelId: string,
    _openerMessageId: string,
  ) => {
    watchInboxItem(`channel:${childChannelId}`)
    cancelPendingNavigation()
    router.push(channelHref(serverId, childChannelId))
  }, [cancelPendingNavigation, router, watchInboxItem])

  const openMarked = useCallback((marked: Marked) => {
    watchInboxItem(`marked:${marked.id}`)
    cancelPendingNavigation()
    const seqQuery = marked.m.seq != null ? `?seq=${marked.m.seq}` : ""
    if (marked.serverId) {
      const channelPath = channelHref(marked.serverId, marked.channelId)
      router.push(`${channelPath}${seqQuery}`)
    } else {
      router.push(`/c/me/${marked.channelId}${seqQuery}`)
    }
  }, [cancelPendingNavigation, router, watchInboxItem])

  const openDm = useCallback((dm: UnreadDm) => {
    const dmId = dm.channelId
    queryClient.setQueryData(
      communityKeys.dms(),
      (previous: DmCache | undefined) =>
        upsertDmSummary(previous, dmSummaryFromInbox(dm)),
    )
    watchInboxItem(`dm:${dmId}`)
    cancelPendingNavigation()
    router.push(`/c/me/${dmId}`)
    void startDmRouteVerification(queryClient, dmId).catch(() => undefined)
  }, [cancelPendingNavigation, queryClient, router, watchInboxItem])

  const popoverProps: ComponentProps<typeof InboxPopover> = {
    unreads: unreadFeed,
    unreadDms,
    mentions,
    marked: inboxMarked.marked,
    markedLoading: inboxMarked.isLoading,
    loading,
    onOpenChannel: openServerChannel,
    onOpenForumThread: openForumThread,
    onOpenDm: openDm,
    onOpenMention: (mention) => {
      if (mention.serverId && mention.channelId) {
        openServerChannel(mention.serverId, mention.channelId, undefined, `mention:${mention.id}`)
      }
    },
    onOpenMarked: openMarked,
    onMarkedTabSelected: () => setMarkedTabOpened(true),
    onMarkAllRead: () => { markAllInboxRead.mutate() },
    onDeleteMention: (id) => deleteMention.mutate({ mentionId: id }),
    onUnmark: (messageId) => unmarkMessageMutate({ messageId }),
  }

  return {
    popoverProps,
    hasUnread:
      unreadFeed.length > 0 || unreadDms.length > 0 || mentions.length > 0,
    open: inbox.open,
    onOpenChange: inbox.onOpenChange,
  }
}
