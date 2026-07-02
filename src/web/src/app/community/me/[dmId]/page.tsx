"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { DmHeader, DmHeaderSkeleton } from "@/components/community/dm-header"
import { Avatar } from "@/components/community/avatar"
import { MessageList } from "@/components/community/message-list"
import { Composer, ComposerSkeleton } from "@/components/community/composer"
import type { OpenProfile } from "@/components/community/_types"

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
  const ctx = useCommunity()

  const goBack = useCallback(() => { ctx.goBackMobile() }, [ctx])

  useEffect(() => {
    ctx.setCurrentChannelId(dmId)
    return () => { ctx.setCurrentChannelId(null) }
  }, [dmId]) // eslint-disable-line react-hooks/exhaustive-deps

  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; text: string } | null>(null)

  useEffect(() => {
    setReplyTo(null)
  }, [dmId])

  const dm = ctx.dms.find((d) => d.id === dmId) ?? null

  const openProfile: OpenProfile = (name, e) => { ctx.openProfile(name, e) }

  const resolveUserName = useCallback((userId: string) => {
    const m = ctx.members.find((x) => x.userId === userId)
    return m?.name ?? userId
  }, [ctx.members])

  const messageActions = useMemo(() => ({
    onToggleReaction: ctx.toggleReaction,
    onReact: ctx.toggleReaction,
    onCopy: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      if (m?.content) { navigator.clipboard?.writeText(m.content); toast("Copied to clipboard") }
    },
    onRetry: (id: string) => {
      const m = ctx.messages.find((x) => x.id === id)
      if (m?.content) ctx.sendMessage(m.content)
    },
  }), [ctx.toggleReaction, ctx.messages, ctx.sendMessage])

  // DM endpoint ignores mentionType. Replies are supported — the backend
  // persists replyToId for DMs too.
  const sendDmMsg = async (markdown: string, attachments?: File[]) => {
    if (!markdown && !attachments?.length) return
    if (!dmId) return
    let uploadedAttachments: { url: string; filename: string; contentType: string; size: number }[] = []
    if (attachments?.length) {
      const results = await Promise.all(
        attachments.map((f) => ctx.uploadFile({ dmId }, f))
      )
      uploadedAttachments = results.filter(Boolean) as typeof uploadedAttachments
    }
    ctx.sendDmMessage(dmId, markdown || "", {
      replyToId: replyTo?.id,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    })
    setReplyTo(null)
  }

  const handleTyping = () => { ctx.sendTyping({ dmConversationId: dmId }) }

  // Wait for context to catch up to the URL and for messages to load. See
  // the server-side channel page for the same rationale — the context's
  // channelId sync runs after this render commits, so gate on the two
  // lining up before showing real content.
  const channelHydrated =
    ctx.currentChannelId === dmId &&
    !ctx.messagesLoading &&
    !ctx.dmsLoading
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

  const dmBlocked = ctx.blocked.some((b) => (b.userId ?? b.id) === dm.userId)

  return (
    <>
      <DmHeader dm={dm} onBack={bp === "mobile" ? goBack : undefined} />
      <main className="flex min-h-0 flex-1 flex-col">
        <MessageList
          channel={dm.name}
          messages={ctx.messages}
          loading={ctx.messagesLoading}
          typingUsers={ctx.typingUsers.map((id) => ctx.friends.find((f) => f.userId === id)?.name ?? id)}
          onOpenThread={() => {}}
          onToggleReaction={dmBlocked ? undefined : messageActions.onToggleReaction}
          onReact={dmBlocked ? undefined : messageActions.onReact}
          onCopy={messageActions.onCopy}
          onRetry={dmBlocked ? undefined : messageActions.onRetry}
          onOpenProfile={openProfile}
          resolveUserName={resolveUserName}
          hero={
            <>
              <div className="relative mb-3 w-fit"><Avatar label={dm.avatar} size={68} /></div>
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
            members={ctx.friends}
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
