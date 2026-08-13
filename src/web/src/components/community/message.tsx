"use client"

import { memo, useState } from "react"
import { useMessageMarked } from "@/hooks/community/use-inbox"
import type React from "react"
import {
  MessagesSquare, UserPlus, SmilePlus, Reply,
  MoreHorizontal, X, Share, Check,
} from "lucide-react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { MessageBody } from "./message-body"
import { BotApprovalCard } from "./bot-approval-card"
import { EmojiPickerPopover } from "./emoji-picker"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { NumberTicker } from "@/components/ui/number-ticker"
import { MessageContextItems, MessageDropdownItems, hasMessageMenu } from "./message-menu"
import { formatMessageTime } from "./format-time"
import { tid } from "@/lib/community/testids"
import { avatarInitial } from "@/lib/community/avatar"
import { displayName } from "@/lib/community/display-name"
import { stripInlineMarkup } from "@alook/shared"
import type { FileAttachment, ImagePreview, RenderMsg, OpenProfile } from "./_types"
import { attachmentAspectRatio } from "./attachment-layout"
import { AttachmentCard } from "./attachment-card"

// Whether the "Share as Image" action is offered for a message. Share is
// computed inside `Message` from the message alone (no handler is threaded in),
// which is exactly why every surface that renders a message — the main list,
// the right-click / long-press context menu, and the #N-ref context sheet —
// inherits an identical action menu. Extracted as a pure predicate so that
// menu-parity guarantee is directly testable. A share card mirrors
// avatar/name/content, so it's meaningful only for a non-compact message that
// has rendered text (an approval- or attachment-only row has nothing to put on
// the card).
export function messageCanShare(m: RenderMsg, compact?: boolean): boolean {
  return !compact && !m.approval && !!m.content
}

export function shouldActivateMessageOverlays(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return !element?.closest?.("button, a, input, textarea, select, [role=button]")
}

function MessageImpl({
  m, compact, pinned, onOpenThread, onOpenProfile, onJumpReply,
  onToggleReaction, onReact, onReply, onPin, onMark, onCreateThread, onCopy, onEdit, onRetry, onDismiss,
  onPreviewImage, onPreviewAttachment, onDownloadFile, highlighted, resolveUserName, onImageLoad,
  selectMode, selected, onToggleSelect, onEnterSelect, onShareSingle,
  viewerUserId,
}: {
  m: RenderMsg
  compact?: boolean
  pinned?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onJumpReply?: () => void
  onToggleReaction?: (emoji: string) => void
  onReact?: (emoji: string) => void
  onReply?: () => void
  onPin?: () => void
  // Toggle this message in the viewer's private saved ("marked") set. The
  // Mark/Unmark label is driven by a lazy per-message read (see `marked`
  // below), so a channel never pre-loads mark state for every row.
  onMark?: () => void
  onCreateThread?: () => void
  onCopy?: () => void
  onEdit?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  onPreviewImage?: (image: ImagePreview) => void
  onPreviewAttachment?: (attachment: FileAttachment) => void
  onDownloadFile?: (url: string, name: string) => void
  highlighted?: boolean
  resolveUserName?: (userId: string) => string
  onImageLoad?: () => void
  // "Share as image" (Gus uiux #128/#142). Two independent ways the Share
  // affordance can act — a surface wires whichever it supports:
  //   · `onEnterSelect` — the main list: clicking Share enters multi-select mode
  //     with this row pre-selected (unified entry; single-share = one pick).
  //   · `onShareSingle` — a surface with no select-mode context (the message
  //     context-sheet peek): clicking Share opens the dialog on just this row.
  // Share shows if EITHER is present — share capability must NOT depend on the
  // select-mode plumbing (Cecilia #511: coupling them silently dropped share
  // from every caller that didn't wire select-mode).
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onEnterSelect?: () => void
  onShareSingle?: () => void
  viewerUserId?: string
}) {
  // keep the hover toolbar pinned open while its ⋯ dropdown is open
  const [toolbarOpen, setToolbarOpen] = useState(false)
  // Right-click context-menu open state — tracked so the Mark/Unmark label's
  // lazy read fires for the context menu too, not just the ⋯ dropdown.
  const [contextOpen, setContextOpen] = useState(false)
  // The Mark/Unmark label needs to know if THIS message is already in the
  // viewer's saved set. That's a single indexed row read, fired lazily only
  // while a menu that shows the item is open (never per-row on mount) — so a
  // channel scroll doesn't pre-load mark state for every row. Defaults to
  // "Mark"; flips to "Unmark" silently once the read resolves (no spinner).
  const markMenuOpen = (toolbarOpen || contextOpen) && !!onMark
  const { data: markedData } = useMessageMarked(m.id, markMenuOpen)
  // Lazy-mount the row's Base UI overlay roots (ContextMenu / DropdownMenu /
  // EmojiPicker Popover / reaction Tooltips). Eagerly mounting them per visible
  // row was the bulk of the switch re-render storm (FloatingTree/MenuRoot ×1000s
  // — see plans/community-switch-perf-optimization.md). Activate on the first
  // hover OR focus OR keydown/contextmenu — focus/keydown are required for a11y
  // (keyboard context menu / Tab-to-row have no pointerenter).
  const [activated, setActivated] = useState(false)

  if (m.type === "system") {
    const Icon = m.systemKind === "thread" ? MessagesSquare : UserPlus
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 wrap-break-word">{m.content}</span>
        <span className="shrink-0 text-xs" suppressHydrationWarning>{formatMessageTime(m.createdAt)}</span>
      </div>
    )
  }

  // Share is only meaningful for a message with rendered text content (the card
  // mirrors avatar/name/content — an approval/attachment-only row has nothing to
  // put on it).
  const canShare = messageCanShare(m, compact)
  const menuHandlers = {
    onAddReaction: onReact ? () => onReact("👍") : undefined,
    onReply, onPin, pinned,
    onMark, marked: markedData?.marked ?? false,
    onCreateThread: m.thread ? undefined : onCreateThread,
    onCopy, onEdit,
    // Share: enter multi-select (main list) if wired, else direct single-share
    // (context-sheet). Undefined only when the surface wired NEITHER.
    onShare: canShare ? (onEnterSelect ?? onShareSingle) : undefined,
  }
  const showMenu = hasMessageMenu(menuHandlers)
  const interactive = !compact && !m.failed && showMenu
  const activate = interactive && !activated
    ? (event: React.SyntheticEvent<HTMLElement>) => {
        if (shouldActivateMessageOverlays(event.target)) setActivated(true)
      }
    : undefined
  // In select mode (multi-share), the whole row is a big toggle target and gets
  // a leading checkbox overlay + a tint when picked. `canShare` rows only —
  // approval/attachment-only rows aren't selectable (nothing to put on the card).
  const selectable = selectMode && canShare
  const row = (
    <div
      className={[
        "group relative -mx-2 flex gap-2 rounded px-2 transition-colors",
        m.grouped ? "py-0" : "mt-3 pt-1.5 pb-0",
        selectable ? "cursor-pointer pl-9" : "",
        selected ? "bg-primary/10" : highlighted ? "bg-primary/10" : selectable ? "hover:bg-accent/40" : "hover:bg-accent/40",
      ].join(" ")}
      onPointerEnter={activate}
      onFocusCapture={activate}
      onKeyDownCapture={activate}
      onClick={selectable ? onToggleSelect : undefined}
    >
      {selectMode && (
        // Checkbox overlay (absolute → no layout shift / no virtualizer
        // remeasure storm on enter/exit, per the list's dynamic measurement).
        // Selectable rows show an interactive box; non-selectable (approval/
        // system) rows show nothing so they read as "can't pick this".
        selectable && (
          <span
            aria-hidden
            className={[
              "absolute left-1.5 top-1/2 z-20 grid size-4 -translate-y-1/2 place-items-center rounded-[5px] border transition-colors",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-card",
            ].join(" ")}
          >
            {selected && <Check className="size-3" strokeWidth={3} />}
          </span>
        )
      )}
      <div className="min-w-0 flex-1">
      {interactive && activated && !selectMode && (
        <div className={`absolute right-2 z-20 flex items-center gap-1 rounded-lg border border-border/60 bg-card px-2 py-1 shadow-(--e1) transition-opacity duration-150 ${m.grouped ? "-top-2" : "-top-3"} ${toolbarOpen ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
          {m.seq != null && m.seq > 0 && (
            <span className="mr-0.5 select-none font-mono text-xs text-muted-foreground" aria-label={`Message ${m.seq}`}>
              <span className="opacity-60">#</span>{m.seq}
            </span>
          )}
          {onReact && (
            <EmojiPickerPopover side="bottom" align="end" onPick={(e) => onReact(e)} onOpenChange={setToolbarOpen}>
              <button data-testid={tid.reactionAdd(m.id)} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:text-foreground" aria-label="Add reaction">
                <SmilePlus className="size-4" />
              </button>
            </EmojiPickerPopover>
          )}
          {onReply && (
            <button onClick={onReply} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Reply">
              <Reply className="size-4" />
            </button>
          )}
          {canShare && (onEnterSelect || onShareSingle) && (
            <button data-testid={tid.messageShare(m.id)} onClick={onEnterSelect ?? onShareSingle} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Share as image">
              <Share className="size-4" />
            </button>
          )}
          <DropdownMenu onOpenChange={setToolbarOpen}>
            <DropdownMenuTrigger
              render={<button aria-label="More actions" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:text-foreground" />}
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
        <button onClick={onJumpReply} className="mb-1 ml-13 flex min-w-0 max-w-[calc(100%-3.25rem)] items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground">
          <div className="h-2 w-4 shrink-0 rounded-tl-md border-l-2 border-t-2 border-border" />
          {m.replyTo.deleted ? (
            <span className="italic text-muted-foreground">Original message was deleted</span>
          ) : (
            <>
              <span className="shrink-0 font-medium text-foreground/80">@{m.replyTo.authorName}</span>
              <span className="min-w-0 truncate">{stripInlineMarkup(m.replyTo.text)}</span>
            </>
          )}
        </button>
      )}

      <div className="flex gap-3">
        {m.grouped ? (
          <div className="w-10 shrink-0" />
        ) : (
          <button onClick={(e) => onOpenProfile?.(m.authorName ?? "", e, undefined, m.authorId)} className="shrink-0 self-start">
            <Avatar label={m.authorAvatar ?? "?"} seed={m.authorId} size={40} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!m.grouped && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={(e) => onOpenProfile?.(m.authorName ?? "", e, undefined, m.authorId)}
                className="min-w-0 max-w-full truncate text-[15px] font-semibold hover:underline"
                style={{ color: m.color ?? "var(--foreground)" }}
              >
                {m.authorName}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>{formatMessageTime(m.createdAt)}</span>
            </div>
          )}
          {m.approval ? (
            <BotApprovalCard approval={m.approval} />
          ) : (
            m.content && (
              <MessageBody
                text={m.content}
                onOpenProfile={onOpenProfile}
                perspective={
                  viewerUserId
                    ? m.authorId === viewerUserId ? "sender" : "recipient"
                    : "neutral"
                }
              />
            )
          )}

          {m.attachments && (
            <div className="mt-2 flex flex-col gap-2 pb-2">
              {m.attachments.map((a, i) => {
                if (a.kind === "image") return (
                  <button
                    key={i}
                    onClick={() => onPreviewImage?.({ originalUrl: a.url, thumbnailUrl: a.thumbnailUrl, name: a.name })}
                    className="block w-fit max-w-full overflow-hidden rounded-lg border border-border transition-colors hover:border-primary/40"
                  >
                    <img
                      data-testid={tid.messageImage(m.id, i)}
                      src={a.thumbnailUrl ?? a.url}
                      alt={a.name}
                      width={a.width}
                      height={a.height}
                      className="block h-auto w-auto max-h-75 max-w-full rounded-lg object-contain"
                      style={{ aspectRatio: attachmentAspectRatio(a.width, a.height) }}
                      onLoad={onImageLoad}
                      loading="lazy"
                    />
                  </button>
                )
                return <AttachmentCard key={i} attachment={a} onPreview={onPreviewAttachment} onDownload={onDownloadFile} />
              })}
            </div>
          )}

          {m.embeds && m.embeds.length > 0 && (
            <div className="mt-2 flex flex-col gap-2 pb-2">
              {m.embeds.map((embed, ei) => (
                <article
                  key={ei}
                  className="flex max-w-108 overflow-hidden rounded-lg border border-border bg-card p-3"
                >
                  {embed.color && (
                    <span
                      className="mt-1.5 mr-3 size-2 shrink-0 self-start rounded-full"
                      style={{ backgroundColor: embed.color }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    {embed.author && (
                      <div className="mb-2 flex items-center gap-2">
                        {embed.author.iconUrl ? (
                          <img src={embed.author.iconUrl} alt="" className="size-5 rounded-full" />
                        ) : (
                          <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{avatarInitial(embed.author.name)}</span>
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
                      <img src={embed.image.url} alt="" width={embed.image.width} height={embed.image.height} className="mt-2 w-full max-w-100 rounded-sm object-cover" style={{ aspectRatio: embed.image.width && embed.image.height ? `${embed.image.width}/${embed.image.height}` : "40/21" }} onLoad={onImageLoad} />
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
              {m.reactions.map((r, i) => {
                const names = r.userIds?.length
                  ? r.userIds.map((id) => resolveUserName?.(id) ?? displayName(null)).join(", ")
                  : undefined
                const chip = (
                  <button
                    onClick={() => onToggleReaction?.(r.emoji)}
                    className={[
                      "flex h-6 items-center gap-1 rounded-md px-2 text-sm",
                      r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                    ].join(" ")}
                  >
                    <span>{r.emoji}</span>
                    <NumberTicker value={r.count} className="text-xs text-muted-foreground" />
                  </button>
                )
                // Until the row is activated, render the bare chip (still fully
                // clickable) without its Base UI Tooltip root — the name tooltip
                // only matters on hover, and hover activates the row.
                if (!names || !activated) return <div key={i}>{chip}</div>
                return (
                  <Tooltip key={i}>
                    <TooltipTrigger render={chip} />
                    <TooltipContent>Reacted by {names}</TooltipContent>
                  </Tooltip>
                )
              })}
              {activated ? (
                <Tooltip>
                  <EmojiPickerPopover side="top" align="start" onPick={(e) => onReact?.(e)}>
                    <TooltipTrigger render={<button className="grid h-6 w-7 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add reaction" />}>
                      <SmilePlus className="size-4" />
                    </TooltipTrigger>
                  </EmojiPickerPopover>
                  <TooltipContent>Add reaction</TooltipContent>
                </Tooltip>
              ) : (
                <button className="grid h-6 w-7 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add reaction">
                  <SmilePlus className="size-4" />
                </button>
              )}
            </div>
          )}

          {m.thread && !compact && (
            <button
              data-testid={tid.threadIndicator(m.id)}
              onClick={() => onOpenThread(m.thread!.id)}
              className="group/thread mt-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/60"
            >
              <MessagesSquare className="size-4 text-primary" />
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
            <div className="mt-1 flex items-center gap-3 text-xs text-destructive">
              <button onClick={onRetry} className="flex items-center gap-2 hover:underline">
                <X className="size-3.5" /> Message failed to send. Click to retry.
              </button>
              {onDismiss && (
                <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground hover:underline">
                  Dismiss
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )

  // Not interactive, or not yet activated → render the bare row (which carries
  // the pointerenter/focus/keydown activation handlers). The row's Base UI
  // ContextMenu root is only mounted once hover/focus has activated it — and a
  // right-click is always preceded by a pointerenter (mouse arriving on the
  // row), and Shift+F10 by focus, so the menu is mounted before it's invoked.
  // (The share-as-image dialog now lives in MessageList — the share button
  // enters multi-select mode; the dialog opens from the select bar there.)
  // In select mode the row is a toggle target — no context menu / toolbar.
  if (!interactive || !activated || selectMode) return row
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger className="select-text" render={row} />
      <ContextMenuContent className="w-48">
        <MessageContextItems {...menuHandlers} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

type MessageProps = Parameters<typeof MessageImpl>[0]

// Custom comparator — REQUIRED, not optional. `flattenMessageItems`
// (message-list-items.ts) spreads a fresh `{ ...m, grouped }` object for every
// message on every render, so a default shallow memo would compare `m` by
// reference, always see "new", and never bail out (a no-op). We instead compare
// the fields that legitimately change and REQUIRE the callbacks + resolveUserName
// to be reference-stable (see message-list callback stabilization). An id-only
// comparator would silently drop edits / reaction / thread-count updates — so
// every user-visible field is enumerated here.
function messagePropsEqual(prev: MessageProps, next: MessageProps): boolean {
  if (prev.m !== next.m) {
    const a = prev.m
    const b = next.m
    if (
      a.id !== b.id ||
      a.type !== b.type ||
      a.content !== b.content ||
      a.grouped !== b.grouped ||
      a.failed !== b.failed ||
      a.authorId !== b.authorId ||
      a.authorName !== b.authorName ||
      a.authorAvatar !== b.authorAvatar ||
      a.color !== b.color ||
      a.createdAt !== b.createdAt ||
      a.reactions !== b.reactions ||
      a.attachments !== b.attachments ||
      a.embeds !== b.embeds ||
      a.replyTo !== b.replyTo ||
      a.thread !== b.thread ||
      a.seq !== b.seq
    ) {
      return false
    }
  }
  return (
    prev.compact === next.compact &&
    prev.pinned === next.pinned &&
    prev.highlighted === next.highlighted &&
    prev.viewerUserId === next.viewerUserId &&
    prev.onOpenThread === next.onOpenThread &&
    prev.onOpenProfile === next.onOpenProfile &&
    prev.onJumpReply === next.onJumpReply &&
    prev.onToggleReaction === next.onToggleReaction &&
    prev.onReact === next.onReact &&
    prev.onReply === next.onReply &&
    prev.onPin === next.onPin &&
    prev.onMark === next.onMark &&
    prev.onCreateThread === next.onCreateThread &&
    prev.onCopy === next.onCopy &&
    prev.onEdit === next.onEdit &&
    prev.onRetry === next.onRetry &&
    prev.onDismiss === next.onDismiss &&
    prev.onPreviewImage === next.onPreviewImage &&
    prev.onPreviewAttachment === next.onPreviewAttachment &&
    prev.onDownloadFile === next.onDownloadFile &&
    prev.resolveUserName === next.resolveUserName &&
    prev.onImageLoad === next.onImageLoad &&
    // Multi-select: `selected` flips per-row on toggle, `selectMode` flips for
    // all rows on enter/exit — both MUST be compared or the checkbox/tint won't
    // re-render. The handlers are stable (id-bound in MessageRow).
    prev.selectMode === next.selectMode &&
    prev.selected === next.selected &&
    prev.onToggleSelect === next.onToggleSelect &&
    prev.onEnterSelect === next.onEnterSelect &&
    prev.onShareSingle === next.onShareSingle
  )
}

export const Message = memo(MessageImpl, messagePropsEqual)
