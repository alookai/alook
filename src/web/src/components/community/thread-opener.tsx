"use client"

import { MessagesSquare, FileText, Download } from "lucide-react"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { formatMessageTime } from "./format-time"
import { Skeleton } from "@/components/ui/skeleton"
import { avatarInitial } from "@/lib/community/avatar"
import { useMessage } from "@/hooks/community/use-message"
import type { OpenProfile } from "./_types"

// Thread opener block — the parent message the thread was created from,
// rendered pinned at the top of the thread's message list. Distinct from
// regular messages: a MessagesSquare "opener" chip + a warm accent border
// on the left, so the user instantly clocks that this is context (from the
// outer channel), not part of the thread's reply timeline.
//
// The parent lives in the OUTER channel — since server membership grants
// channel access, any thread viewer can fetch it via the shared endpoint.
// Fetching client-side (rather than embedding in the /threads/[id] response)
// keeps the parent live: an edit or reaction on the source message would
// reflect here without a page reload once the mutation invalidates this key.
export function ThreadOpener({
  parentMessageId,
  onOpenProfile,
  onPreviewImage,
  onDownloadFile,
}: {
  parentMessageId: string
  onOpenProfile?: OpenProfile
  onPreviewImage?: (url: string) => void
  onDownloadFile?: (url: string) => void
}) {
  const { message: msg, isLoading, isError } = useMessage(parentMessageId)

  if (isLoading) return <ThreadOpenerSkeleton />

  if (isError || !msg) {
    // The parent lives in the outer channel; if it was deleted (or the caller
    // lost access) we don't fail the thread view — just render a minimal
    // placeholder so the opener slot doesn't collapse the layout.
    return (
      <div className="mb-4 rounded-md border-l-2 border-muted bg-muted/30 px-4 py-3">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <MessagesSquare className="size-3.5" />
          <span>Opener</span>
        </div>
        <p className="text-sm italic text-muted-foreground">Original message is unavailable.</p>
      </div>
    )
  }

  const avatarLabel = msg.authorAvatar || avatarInitial(msg.authorName)

  return (
    <div className="mb-4 rounded-md border-l-2 border-primary/60 bg-accent/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <MessagesSquare className="size-3.5 text-primary/80" />
        <span>Opener</span>
      </div>

      <div className="flex gap-3">
        <button
          onClick={(e) => onOpenProfile?.(msg.authorName, e)}
          className="shrink-0 self-start"
        >
          <Avatar label={avatarLabel} size={32} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <button
              onClick={(e) => onOpenProfile?.(msg.authorName, e)}
              className="text-sm font-semibold hover:underline"
            >
              {msg.authorName}
            </button>
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {formatMessageTime(msg.createdAt)}
            </span>
          </div>

          {msg.content && <MessageBody text={msg.content} />}

          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {msg.attachments.map((a, i) =>
                a.kind === "image" ? (
                  <button
                    key={i}
                    onClick={() => onPreviewImage?.(a.url)}
                    className="block w-fit max-w-[280px] overflow-hidden rounded-md border border-border transition-colors hover:border-primary/40"
                  >
                    <img src={a.url} alt={a.name} className="max-h-40 max-w-[280px] rounded-md object-contain" />
                  </button>
                ) : (
                  <button
                    key={i}
                    onClick={() => onDownloadFile?.(a.url)}
                    className="flex w-full max-w-[280px] items-center gap-3 rounded-md border border-border bg-card p-2 text-left transition-colors hover:bg-accent"
                  >
                    <FileText className="size-6 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-primary">{a.name}</div>
                      {"size" in a && a.size && (
                        <div className="text-xs text-muted-foreground">{a.size}</div>
                      )}
                    </div>
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ),
              )}
            </div>
          )}

          {msg.reactions && msg.reactions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {msg.reactions.map((r, i) => (
                <span
                  key={i}
                  className={[
                    "flex h-6 items-center gap-1 rounded-md px-2 text-sm",
                    r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                  ].join(" ")}
                >
                  <span>{r.emoji}</span>
                  <span className="text-xs text-muted-foreground">{r.count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ThreadOpenerSkeleton() {
  return (
    <div className="mb-4 rounded-md border-l-2 border-muted bg-muted/30 px-4 py-3">
      <Skeleton className="mb-2 h-3 w-16 rounded" />
      <div className="flex gap-3">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3.5 w-full max-w-[260px] rounded" />
          <Skeleton className="h-3.5 w-40 rounded" />
        </div>
      </div>
    </div>
  )
}
