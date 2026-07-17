"use client"

import { MessagesSquare, FileText, Download, ArrowUpRight } from "lucide-react"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { attachmentAspectRatio } from "./message"
import { formatMessageTime } from "./format-time"
import { Skeleton } from "@/components/ui/skeleton"
import { NumberTicker } from "@/components/ui/number-ticker"
import { avatarInitial } from "@/lib/community/avatar"
import { useMessage } from "@/hooks/community/use-message"
import type { OpenProfile } from "./_types"

// Thread opener — the parent message the thread was created from, pinned at
// the top of the thread's message list. Deliberately styled like a REGULAR
// message row (same 40px avatar, same name/timestamp/body scale as
// `Message`) rather than a boxed-off card — `/c` never wraps
// messages in cards, so a tinted, bordered box here would read as a
// foreign component instead of "the message this thread grew out of." A
// plain caption above it is enough to mark it as context, not part of the
// thread's own reply timeline.
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
  onJump,
}: {
  parentMessageId: string
  onOpenProfile?: OpenProfile
  onPreviewImage?: (url: string) => void
  onDownloadFile?: (url: string) => void
  // Jump to the parent message in its channel. When provided, a hover-revealed
  // "Jump" button appears in the opener's top-right.
  onJump?: () => void
}) {
  const { message: msg, isLoading, isError } = useMessage(parentMessageId)

  if (isLoading) return <ThreadOpenerSkeleton />

  if (isError || !msg) {
    // The parent lives in the outer channel; if it was deleted (or the caller
    // lost access) we don't fail the thread view — just render a minimal
    // placeholder so the opener slot doesn't collapse the layout.
    return (
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MessagesSquare className="size-3.5" />
          <span>Thread started from a message</span>
        </div>
        <p className="text-sm italic text-muted-foreground">Original message is unavailable.</p>
      </div>
    )
  }

  const avatarLabel = msg.authorAvatar || avatarInitial(msg.authorName)

  return (
    <div className="group relative">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessagesSquare className="size-3.5" />
        <span>Thread started from</span>
      </div>

      {onJump && (
        <button
          type="button"
          onClick={onJump}
          className="absolute right-0 top-0 flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-hover:opacity-100"
          aria-label="Jump to message"
          title="Jump to message"
        >
          <ArrowUpRight className="size-3.5" />
          Jump
        </button>
      )}

      <div className="flex gap-3">
        <button
          onClick={(e) => onOpenProfile?.(msg.authorName, e, undefined, msg.authorId)}
          className="shrink-0 self-start"
        >
          <Avatar label={avatarLabel} seed={msg.authorId} size={40} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <button
              onClick={(e) => onOpenProfile?.(msg.authorName, e, undefined, msg.authorId)}
              className="text-[15px] font-semibold hover:underline"
            >
              {msg.authorName}
            </button>
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {formatMessageTime(msg.createdAt)}
            </span>
          </div>

          {msg.content && <MessageBody text={msg.content} onOpenProfile={onOpenProfile} />}

          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-2 flex flex-col gap-2 pb-2">
              {msg.attachments.map((a, i) =>
                a.kind === "image" ? (
                  <button
                    key={i}
                    onClick={() => onPreviewImage?.(a.url)}
                    className="block w-fit max-w-[320px] overflow-hidden rounded-lg border border-border transition-colors hover:border-primary/40"
                  >
                    <img src={a.url} alt={a.name} className="max-h-50 max-w-[320px] rounded-lg object-contain" style={{ aspectRatio: attachmentAspectRatio(a.width, a.height) }} />
                  </button>
                ) : (
                  <button
                    key={i}
                    onClick={() => onDownloadFile?.(a.url)}
                    className="flex w-full max-w-[320px] items-center gap-3 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:bg-accent"
                  >
                    <FileText className="size-7 shrink-0 text-muted-foreground" />
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
                    "flex h-6 items-center gap-1 rounded-full px-2 text-sm",
                    r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                  ].join(" ")}
                >
                  <span>{r.emoji}</span>
                  <NumberTicker value={r.count} className="text-xs text-muted-foreground" />
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
    <div>
      <Skeleton className="mb-2 h-3 w-32 rounded" />
      <div className="flex gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3.5 w-full max-w-80 rounded" />
          <Skeleton className="h-3.5 w-48 rounded" />
        </div>
      </div>
    </div>
  )
}
