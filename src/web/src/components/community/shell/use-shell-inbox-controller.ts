"use client"

import { useCallback, useState, type ComponentProps } from "react"
import { communityKeys } from "@/lib/query-keys"
import { childChannelHref } from "@/lib/community/community-route"
import type { Marked } from "@/lib/community/models/inbox"
import { useInboxUnreads, useInboxMentions, useInboxMarked } from "@/hooks/community/use-inbox"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import {
  useMarkAllInboxRead,
  useDeleteMention,
  useUnmarkMessage,
  useReadForumThreadFromInbox,
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
  const { mutate: readForumThreadFromInbox } = useReadForumThreadFromInbox()
  const inbox = useInboxAutoCollapse({ unreads: unreadFeed, unreadDms, mentions })
  const watchInboxItem = inbox.watchItem

  const openServerChannel = useCallback((
    serverId: string,
    channelId: string,
    parentChannelId?: string,
    watchKey: string = `channel:${channelId}`,
  ) => {
    watchInboxItem(watchKey)
    cancelPendingNavigation()
    router.push(parentChannelId
      ? childChannelHref(serverId, parentChannelId, channelId)
      : `/c/channels/${serverId}/${channelId}`)
  }, [cancelPendingNavigation, router, watchInboxItem])

  const openForumThread = useCallback((
    serverId: string,
    parentChannelId: string,
    childChannelId: string,
    openerMessageId: string,
  ) => {
    watchInboxItem(`channel:${childChannelId}`)
    readForumThreadFromInbox({ parentChannelId, openerMessageId })
    cancelPendingNavigation()
    router.push(childChannelHref(serverId, parentChannelId, childChannelId))
  }, [cancelPendingNavigation, readForumThreadFromInbox, router, watchInboxItem])

  const openMarked = useCallback((marked: Marked) => {
    watchInboxItem(`marked:${marked.id}`)
    cancelPendingNavigation()
    const seqQuery = marked.m.seq != null ? `?seq=${marked.m.seq}` : ""
    if (marked.serverId) {
      router.push(`/c/channels/${marked.serverId}/${marked.channelId}${seqQuery}`)
    } else {
      router.push(`/c/me/${marked.channelId}${seqQuery}`)
    }
  }, [cancelPendingNavigation, router, watchInboxItem])

  const openDm = useCallback((dmId: string) => {
    queryClient.setQueryData(
      communityKeys.dms(),
      (previous: { conversations: { id: string; unread?: boolean }[] } | undefined) =>
        previous
          ? {
            ...previous,
            conversations: previous.conversations.map((dm) =>
              dm.id === dmId ? { ...dm, unread: false } : dm
            ),
          }
          : previous,
    )
    watchInboxItem(`dm:${dmId}`)
    cancelPendingNavigation()
    router.push(`/c/me/${dmId}`)
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
