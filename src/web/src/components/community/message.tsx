"use client"

import { useState } from "react"
import type React from "react"
import {
  MessagesSquare, UserPlus, SmilePlus, Reply,
  MoreHorizontal, FileText, Download, X,
} from "lucide-react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { EmojiPickerPopover } from "./emoji-picker"
import { MessageContextItems, MessageDropdownItems, hasMessageMenu } from "./message-menu"
import { formatMessageTime } from "./format-time"
import type { Msg, OpenProfile } from "./_types"

export function Message({
  m, compact, pinned, onOpenThread, onOpenProfile, onJumpReply,
  onToggleReaction, onReact, onReply, onPin, onCreateThread, onCopy, onRetry,
  onPreviewImage, onDownloadFile, highlighted, resolveUserName,
}: {
  m: Msg
  compact?: boolean
  pinned?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onJumpReply?: () => void
  onToggleReaction?: (emoji: string) => void
  onReact?: (emoji: string) => void
  onReply?: () => void
  onPin?: () => void
  onCreateThread?: () => void
  onCopy?: () => void
  onRetry?: () => void
  onPreviewImage?: (name: string) => void
  onDownloadFile?: (name: string) => void
  highlighted?: boolean
  resolveUserName?: (userId: string) => string
}) {
  // keep the hover toolbar pinned open while its ⋯ dropdown is open
  const [toolbarOpen, setToolbarOpen] = useState(false)

  if (m.type === "system") {
    const Icon = m.systemKind === "thread" ? MessagesSquare : UserPlus
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span>{m.content}</span>
        <span className="text-xs" suppressHydrationWarning>{formatMessageTime(m.createdAt)}</span>
      </div>
    )
  }

  const menuHandlers = {
    onAddReaction: onReact ? () => onReact("👍") : undefined,
    onReply, onPin, pinned,
    onCreateThread: m.thread ? undefined : onCreateThread,
    onCopy,
  }
  const showMenu = hasMessageMenu(menuHandlers)
  const interactive = !compact && showMenu
  const row = (
    <div
      id={`dpv-${m.id}`}
      className={[
        "group relative -mx-2 flex gap-2 rounded px-2 transition-colors",
        m.grouped ? "py-0" : "mt-3 pt-1.5 pb-0",
        highlighted ? "bg-primary/10" : "hover:bg-accent/40",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1">
      {interactive && (
        <div className={`absolute right-2 z-20 flex items-center gap-1 rounded-lg border border-border/60 bg-card px-2 py-1 shadow-(--e1) transition-opacity duration-150 ${m.grouped ? "-top-2" : "-top-3"} ${toolbarOpen ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
          {onReact && (
            <EmojiPickerPopover side="bottom" align="end" onPick={(e) => onReact(e)} onOpenChange={setToolbarOpen}>
              <button className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:text-foreground" aria-label="Add reaction">
                <SmilePlus className="size-4" />
              </button>
            </EmojiPickerPopover>
          )}
          {onReply && (
            <button onClick={onReply} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Reply">
              <Reply className="size-4" />
            </button>
          )}
          <DropdownMenu onOpenChange={setToolbarOpen}>
            <DropdownMenuTrigger
              render={<button className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:text-foreground" />}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <MessageDropdownItems {...menuHandlers} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {m.replyTo && (
        <button onClick={onJumpReply} className="mb-1 ml-13 flex items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground">
          <div className="h-2 w-4 rounded-tl-md border-l-2 border-t-2 border-border" />
          {m.replyTo.deleted ? (
            <span className="italic text-muted-foreground">Original message was deleted</span>
          ) : (
            <>
              <span className="font-medium text-foreground/80">@{m.replyTo.authorName}</span>
              <span className="truncate">{m.replyTo.text}</span>
            </>
          )}
        </button>
      )}

      <div className="flex gap-3">
        {m.grouped ? (
          <div className="w-10 shrink-0" />
        ) : (
          <button onClick={(e) => onOpenProfile?.(m.authorName ?? "", e)} className="shrink-0 self-start">
            <Avatar label={m.authorAvatar ?? "?"} size={40} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!m.grouped && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={(e) => onOpenProfile?.(m.authorName ?? "", e)}
                className="text-[15px] font-semibold hover:underline"
                style={{ color: m.color ?? "var(--foreground)" }}
              >
                {m.authorName}
              </button>
              <span className="text-xs text-muted-foreground" suppressHydrationWarning>{formatMessageTime(m.createdAt)}</span>
            </div>
          )}
          {m.content && (
            <MessageBody text={m.content} />
          )}

          {m.attachments && (
            <div className="mt-2 flex flex-col gap-2">
              {m.attachments.map((a, i) =>
                a.kind === "image" ? (
                  <button
                    key={i}
                    onClick={() => onPreviewImage?.(a.url)}
                    className="block w-fit max-w-[320px] overflow-hidden rounded-md border border-border transition-colors hover:border-primary/40"
                  >
                    <img src={a.url} alt={a.name} className="max-h-50 max-w-[320px] rounded-md object-contain" />
                  </button>
                ) : (
                  <button
                    key={i}
                    onClick={() => onDownloadFile?.(a.url)}
                    className="flex w-full max-w-[320px] items-center gap-3 rounded-md border border-border bg-card p-2 text-left transition-colors hover:bg-accent"
                  >
                    <FileText className="size-7 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-primary">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{a.size}</div>
                    </div>
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ),
              )}
            </div>
          )}

          {m.embeds && m.embeds.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {m.embeds.map((embed, ei) => (
                <article
                  key={ei}
                  className="flex max-w-108 overflow-hidden rounded-md border-l-4 bg-card p-3"
                  style={{ borderLeftColor: embed.color ?? "var(--border)" }}
                >
                  <div className="min-w-0 flex-1">
                    {embed.author && (
                      <div className="mb-2 flex items-center gap-2">
                        {embed.author.iconUrl ? (
                          <img src={embed.author.iconUrl} alt="" className="size-5 rounded-full" />
                        ) : (
                          <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{embed.author.name.charAt(0)}</span>
                        )}
                        {embed.author.url ? (
                          <a href={embed.author.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium hover:underline">{embed.author.name}</a>
                        ) : (
                          <span className="text-xs font-medium">{embed.author.name}</span>
                        )}
                      </div>
                    )}
                    {embed.provider && <div className="text-xs text-muted-foreground">{embed.provider}</div>}
                    {embed.url ? (
                      <a href={embed.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium text-primary hover:underline">{embed.title}</a>
                    ) : (
                      <div className="mt-1 font-medium">{embed.title}</div>
                    )}
                    {embed.desc && <p className="mt-1 text-sm text-muted-foreground">{embed.desc}</p>}

                    {embed.fields && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                        {embed.fields.map((f, fi) => (
                          <div key={fi} className={f.inline ? "min-w-[30%] flex-1" : "w-full"}>
                            <div className="text-xs font-semibold">{f.name}</div>
                            <div className="text-xs text-muted-foreground">{f.value}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {embed.image && (
                      <img src={embed.image.url} alt="" className="mt-2 w-full max-w-100 rounded-sm object-cover" style={{ aspectRatio: embed.image.width && embed.image.height ? `${embed.image.width}/${embed.image.height}` : "40/21" }} />
                    )}

                    {embed.footer && (
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {embed.footer.iconUrl && <img src={embed.footer.iconUrl} alt="" className="size-4 rounded-full" />}
                        <span>{embed.footer.text}</span>
                      </div>
                    )}
                  </div>

                  {embed.thumbnail && (
                    <img src={embed.thumbnail.url} alt="" className="ml-3 size-16 shrink-0 rounded-md object-cover" />
                  )}
                </article>
              ))}
            </div>
          )}

          {m.reactions && (
            <div className="mt-2 flex flex-wrap gap-1">
              {m.reactions.map((r, i) => (
                <button
                  key={i}
                  onClick={() => onToggleReaction?.(r.emoji)}
                  title={r.userIds?.length ? r.userIds.map((id) => resolveUserName?.(id) ?? id).join(", ") : undefined}
                  className={[
                    "flex h-6 items-center gap-1 rounded-md px-2 text-sm",
                    r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                  ].join(" ")}
                >
                  <span>{r.emoji}</span>
                  <span className="text-xs text-muted-foreground">{r.count}</span>
                </button>
              ))}
              <EmojiPickerPopover side="top" align="start" onPick={(e) => onReact?.(e)}>
                <button className="grid h-6 w-7 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add reaction">
                  <SmilePlus className="size-4" />
                </button>
              </EmojiPickerPopover>
            </div>
          )}

          {m.thread && !compact && (
            <button
              onClick={() => onOpenThread(m.thread!.id)}
              className="group/thread mt-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/60"
            >
              {m.thread.participants && m.thread.participants.length > 0 ? (
                <div className="flex -space-x-2">
                  {m.thread.participants.slice(0, 3).map((p, i) => (
                    <Avatar key={i} label={p} size={20} />
                  ))}
                </div>
              ) : (
                <MessagesSquare className="size-4 text-primary" />
              )}
              <span className="font-medium text-primary">
                {m.thread.messageCount} {m.thread.messageCount === 1 ? "reply" : "replies"}
              </span>
              {m.thread.lastReplyAt && (
                <span className="text-xs text-muted-foreground group-hover/thread:hidden" suppressHydrationWarning>
                  Last reply {formatMessageTime(m.thread.lastReplyAt)}
                </span>
              )}
              <span className="hidden text-xs text-muted-foreground group-hover/thread:inline">View thread</span>
            </button>
          )}

          {m.failed && (
            <button onClick={onRetry} className="mt-1 flex items-center gap-2 text-xs text-destructive hover:underline">
              <X className="size-3.5" /> Message failed to send. Click to retry.
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  )

  if (!interactive) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-48">
        <MessageContextItems {...menuHandlers} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
