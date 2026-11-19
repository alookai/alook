"use client"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { Msg } from "@/lib/community/models/message"

export function MessageReplyPreview({ reply, authorName, onJump }: {
  reply: Msg["replyTo"]
  authorName: string
  onJump?: () => void
}) {
  if (!reply) return null
  const loading = !reply.deleted && reply.loading === true
  return <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
    <Button
      variant="link"
      size="sm"
      aria-label="Show original message"
      aria-busy={loading || undefined}
      onClick={onJump}
      style={{ height: 20 }}
      className="col-start-2 flex h-auto min-w-0 items-center justify-start gap-2 whitespace-nowrap p-0 text-left text-[13px] leading-5 font-normal text-muted-foreground hover:text-foreground hover:no-underline"
    >
      <div className="h-2 w-4 shrink-0 rounded-tl-md border-l-2 border-t-2 border-border" />
      {reply.deleted ? <span className="truncate italic text-muted-foreground">Original message was deleted</span> : loading ? (
        <div role="status" aria-label="Loading quoted message" className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton aria-hidden className="h-3 w-16 shrink-0" />
          <Skeleton aria-hidden className="h-3 min-w-0 flex-1" />
        </div>
      ) : <>
        <span className="max-w-[40%] shrink-0 truncate text-foreground/80">@{authorName}</span>
        <span className="min-w-0 truncate">{reply.text}</span>
      </>}
    </Button>
  </div>
}
