"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import { useBreakpoint } from "@/hooks/use-mobile"
import { DmHeader, DmHeaderSkeleton } from "@/components/community/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import type { OpenProfile } from "@/components/community/_types"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import { useOnlineUserIds } from "@/stores/community/ws"
import { useDms } from "@/hooks/community/use-dms"
import { useFriends } from "@/hooks/community/use-friends"
import { useDmMessages } from "@/hooks/community/use-messages"
import {
  useSendDmMessage,
  useToggleReactionApi,
  useUploadFile,
} from "@/hooks/community/mutations"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  communityWsSubscribe,
  communityWsUnsubscribe,
  communityWsSendTyping,
} from "@/hooks/community/use-community-ws"

// Thin re-mount wrapper — same reason as the server-side channel view: the
// dynamic segment reuses the same component instance across DM switches, so
// keying by dmId tears down the previous view before the next paints.
export default function DmPage() {
  const params = useParams<{ dmId: string }>()
  return <DmView key={params.dmId} />
}

function DmView() {
  const params = useParams<{ dmId: string }>()
  const dmId = params.dmId
  const bp = useBreakpoint()
  const currentUser = useCurrentUser()
  const currentChannelId = useCurrentChannelId()
  const uiHandlers = useUiHandlers()

  const { dms, isLoading: dmsLoading } = useDms()
  const { friends: rawFriends, blocked } = useFriends()
  const onlineUserIds = useOnlineUserIds()
  // Enrich with presence — the Composer @-picker uses `f.status` to render
  // the avatar presence dot; without this enrichment every avatar shows offline.
  const friends = useMemo(
    () =>
      rawFriends.map((f) => ({
        ...f,
        status: onlineUserIds.has(f.userId ?? f.id)
          ? ("online" as const)
          : ("offline" as const),
      })),
    [rawFriends, onlineUserIds],
  )
  const {
    messages,
    isLoading: messagesLoading,
  } = useDmMessages(dmId)
  const typingUsers = useCommunityStore((s) => s.typingUsers)
  const sendDmMessage = useSendDmMessage()
  const toggleReaction = useToggleReactionApi()
  const uploadFile = useUploadFile()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])

  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(dmId)
    communityWsSubscribe({ dmConversationId: dmId })
    return () => {
      useCommunityStore.getState().setCurrentChannelId(null)
      communityWsUnsubscribe()
    }
  }, [dmId])

  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)

  useEffect(() => {
    setReplyTo(null)
  }, [dmId])

  const dm = useMemo(() => {
    const raw = dms.find((d) => d.id === dmId) ?? null
    if (!raw) return null
    return {
      ...raw,
      status: onlineUserIds.has(raw.userId)
        ? ("online" as const)
        : ("offline" as const),
    }
  }, [dms, dmId, onlineUserIds])

  const openProfile: OpenProfile = (name, e) => {
    uiHandlers.openProfile?.(name, e)
  }

  const resolveUserName = useCallback((userId: string) => {
    const f = friends.find((x) => x.userId === userId)
    return f?.name ?? userId
  }, [friends])

  const messageActions = useMemo(() => ({
    onToggleReaction: (id: string, emoji: string) =>
      toggleReaction({ dmId, messageId: id, emoji, userId: currentUser.id }),
    onReact: (id: string, emoji: string) =>
      toggleReaction({ dmId, messageId: id, emoji, userId: currentUser.id }),
    onCopy: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    onRetry: (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (m?.content) {
        sendDmMessage.mutate({
          dmId,
          content: m.content,
          author: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
        })
      }
    },
  }), [toggleReaction, dmId, currentUser.id, currentUser.name, currentUser.avatar, messages, sendDmMessage])

  // DM endpoint ignores mentionType. Replies are supported — the backend
  // persists replyToId for DMs too.
  const sendDmMsg = async (markdown: string, attachments?: File[]) => {
    if (!markdown && !attachments?.length) return
    if (!dmId) return
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) =>
          uploadFile.mutateAsync({ target: { dmId }, file: f }).catch(() => null),
        ),
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }
    sendDmMessage.mutate({
      dmId,
      content: markdown || "",
      replyToId: replyTo?.id,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      author: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
      },
    })
    setReplyTo(null)
  }

  const handleTyping = () => { communityWsSendTyping({ dmConversationId: dmId }) }

  // Wait for query to catch up to the URL and for messages to load. See
  // the server-side channel page for the same rationale — the store's
  // channelId sync runs after this render commits, so gate on the two
  // lining up before showing real content.
  const channelHydrated =
    currentChannelId === dmId &&
    !messagesLoading &&
    !dmsLoading
  if (!channelHydrated) {
    return (
      <>
        <DmHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList channel="" messages={[]} loading={true} onOpenThread={() => {}} hero={<></>} />
          <ComposerSkeleton />
        </main>
      </>
    )
  }

  if (!dm) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <span className="text-sm">Conversation not found</span>
      </div>
    )
  }

  const dmBlocked = blocked.some((b) => (b.userId ?? b.id) === dm.userId)

  return (
    <>
      <DmHeader dm={dm} onBack={bp === "mobile" ? goBack : undefined} />
      <main className="flex min-h-0 flex-1 flex-col">
        <MessageList
          channel={dm.name}
          messages={messages}
          loading={messagesLoading}
          typingUsers={typingUsers.map((id) => friends.find((f) => f.userId === id)?.name ?? id)}
          onOpenThread={() => {}}
          onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
          onReact={dmBlocked ? undefined : messageActions.onReact}
          onCopy={messageActions.onCopy}
          onRetry={dmBlocked ? undefined : messageActions.onRetry}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          hero={
            <>
              <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} size={64} /></div>
              <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p>
            </>
          }
        />
        {dmBlocked ? (
          <div className="flex h-14 shrink-0 items-center justify-center border-t border-border/40 px-4 text-sm text-muted-foreground">
            You have blocked this user. Unblock to send messages.
          </div>
        ) : (
          <Composer
            channel={dm.name}
            context="dm"
            // DM context short-circuits `rankMentionItems` to `[]` — no popup,
            // no candidate pool needed. Passing [] keeps the Member[] typing
            // honest without shimming friends into a member shape.
            members={[]}
            onSend={sendDmMsg}
            onTyping={handleTyping}
            replyingTo={replyTo?.authorName}
            onCancelReply={() => setReplyTo(null)}
          />
        )}
      </main>
    </>
  )
}
