"use client"

import { memo, useRef, useState } from "react"
import { useMessageMarked } from "@/hooks/community/use-inbox"
import type React from "react"
import {
  MessagesSquare, UserPlus, SmilePlus, Reply,
  MoreHorizontal, X, Share, Check,
} from "lucide-react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { Avatar } from "../avatar"
import { MessageBody } from "./message-body"
import {
  copyMessageExternalLink,
  messageExternalLinkTargetFromEventTarget,
  MessageExternalLink,
  openMessageExternalLink,
  type MessageExternalLinkTarget,
} from "./message-external-link"
import { BotApprovalCard } from "../social/bot-approval-card"
import { EmojiPickerPopover } from "./emoji-picker"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { MessageContextItems, MessageDropdownItems, hasMessageMenu } from "./message-menu"
import { formatMessageTime } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { avatarInitial } from "@/lib/community/avatar"
import { stripInlineMarkup } from "@alook/shared"
import type { FileAttachment, ImagePreview, RenderMsg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { attachmentImageFrameStyle } from "./attachment-layout"
import { AttachmentCard } from "./attachment-card"
import { displayReplyContent } from "@/lib/community/reply-content"
import {
  advanceMobileReplyGesture,
  beginMobileReplyGesture,
  shouldCommitMobileReply,
  shouldSuppressClickAfterMobileReplyGesture,
  type MobileReplyGesture,
} from "./mobile-message-gesture"
import { useMobileAvatarMention } from "./use-mobile-avatar-mention"
import { useCommunityProfile } from "@/stores/community/ws"
import { MessageReactions } from "./message-reactions"
import { RemoteContentImage, RemoteIdentityImage } from "@/components/remote-image/remote-image"

// Whether the "Share as Image" action is offered for a message. Share is
// computed inside `Message` from the message alone (no handler is threaded in),
// which is exactly why every surface that renders a message — the main list,
// the right-click / long-press context menu, and the #N-ref context sheet —
// inherits an identical action menu. Extracted as a pure predicate so that
// menu-parity guarantee is directly testable. A share card mirrors
// avatar/name/content/images, so it's meaningful only for a non-compact message
// that has rendered text or at least one image attachment. File-only and
// approval rows still have no visual message content for the card.
export function messageCanShare(m: RenderMsg, compact?: boolean): boolean {
  return !compact
    && !m.approval
    && (
      !!displayReplyContent(m.content ?? "", m.replyTo)
      || !!m.attachments?.some((attachment) => attachment.kind === "image")
    )
}

export function shouldActivateMessageOverlays(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return !element?.closest?.("button, a, input, textarea, select, [role=button]")
}

export function messageEventBelongsToRow(
  target: EventTarget | null,
  row: { contains?: (target: Node | null) => boolean } | null,
): boolean {
  // React portal events follow the component tree, so they can reach the
  // message row even though their DOM target lives in an overlay elsewhere.
  // Real row elements always expose `contains`; the fallback keeps lightweight
  // non-DOM event doubles compatible with these pure render tests.
  return typeof row?.contains !== "function" || row.contains(target as Node | null)
}

export function shouldAdoptDesktopMenuInput(
  pointerType: string | null,
  row: { contains?: (target: Node | null) => boolean } | null,
  activeElement: Element | null,
): boolean {
  if (pointerType !== "mouse") return false
  return typeof row?.contains !== "function" || !row.contains(activeElement)
}

export function shouldSuppressTouchMenuOpen({
  nestedControl,
  selectionInsideRow,
  longPress,
}: {
  nestedControl: boolean
  selectionInsideRow: boolean
  longPress: boolean
}): boolean {
  return nestedControl || selectionInsideRow || longPress
}

type RowSelection = Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode">

export function selectionBelongsToRow(
  selection: RowSelection | null,
  row: Pick<HTMLElement, "contains">,
): boolean {
  if (!selection || selection.isCollapsed) return false
  return (!!selection.anchorNode && row.contains(selection.anchorNode))
    || (!!selection.focusNode && row.contains(selection.focusNode))
}

export function createMessageMenuPointAnchor(clientX: number, clientY: number) {
  const rect = {
    x: clientX,
    y: clientY,
    top: clientY,
    right: clientX,
    bottom: clientY,
    left: clientX,
    width: 0,
    height: 0,
    toJSON: () => ({
      x: clientX,
      y: clientY,
      top: clientY,
      right: clientX,
      bottom: clientY,
      left: clientX,
      width: 0,
      height: 0,
    }),
  } satisfies DOMRect

  return { getBoundingClientRect: () => rect }
}

export function messageLinkPointerType(
  event: Pick<Event, "type"> & {
    pointerType?: unknown
    sourceCapabilities?: { firesTouchEvents?: boolean } | null
  } | null | undefined,
): string | null {
  if (!event) return null
  if (typeof event.pointerType === "string" && event.pointerType) return event.pointerType
  if (event.sourceCapabilities?.firesTouchEvents) return "touch"
  return null
}

export function messageLinkClickUsesMenu({
  clickPointerType,
  capturedPointerType,
  hoverCapable,
  desktopInputSeen = false,
}: {
  clickPointerType: string | null
  capturedPointerType: string | null
  hoverCapable: boolean
  desktopInputSeen?: boolean
}): boolean {
  const pointerType = clickPointerType ?? capturedPointerType
  if (pointerType === "touch" || pointerType === "pen") return true
  if (pointerType === "mouse") return false
  return !(hoverCapable || desktopInputSeen)
}

function MessageImpl({
  m, compact, pinned, onOpenThread, onOpenProfile, onJumpReply,
  onToggleReaction, onReact, onReply, onMentionAuthor, onPin, onMark, onCreateThread, onCopy, onEdit, onRetry, onDismiss,
  onPreviewImage, onPreviewAttachment, highlighted, resolveUserName, onImageLoad,
  selectMode, selected, onToggleSelect, onEnterSelect, onShareSingle,
  viewerUserId, hoverCapable = true,
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
  onMentionAuthor?: () => void
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
  // Resolved once by MessageList and threaded into virtualized rows. Keeping
  // the media-query subscription at the list level avoids one listener per
  // visible message. Non-interactive standalone previews can use the desktop
  // default without subscribing at all.
  hoverCapable?: boolean
}) {
  const authorProfile = useCommunityProfile(m.authorId)
  const replyAuthorProfile = useCommunityProfile(m.replyTo?.authorId)
  const authorName = m.authorId
    ? (authorProfile?.name ?? "Unknown")
    : (m.authorName ?? "Unknown")
  const authorAvatar = m.authorId
    ? (authorProfile?.avatar ?? avatarInitial(authorName))
    : (m.authorAvatar ?? avatarInitial(authorName))
  const replyAuthorName = m.replyTo?.authorId
    ? (replyAuthorProfile?.name ?? "Unknown")
    : (m.replyTo?.authorName ?? "Unknown")
  const visibleContent = displayReplyContent(m.content ?? "", m.replyTo)
  // keep the hover toolbar pinned open while its ⋯ dropdown is open
  const [toolbarOpen, setToolbarOpen] = useState(false)
  // Right-click context-menu open state — tracked so the Mark/Unmark label's
  // lazy read fires for the context menu too, not just the ⋯ dropdown.
  const [contextOpen, setContextOpen] = useState(false)
  // Touch devices use a normal tap-triggered dropdown. Long-press is left to
  // the browser so message text keeps native selection/copy behavior.
  const [touchMenuOpen, setTouchMenuOpen] = useState(false)
  const [touchMenuAnchor, setTouchMenuAnchor] = useState<ReturnType<typeof createMessageMenuPointAnchor> | null>(null)
  const [linkTarget, setLinkTarget] = useState<MessageExternalLinkTarget | null>(null)
  const [desktopMenuInputSeen, setDesktopMenuInputSeen] = useState(false)
  const linkPointerRef = useRef<{
    href: string
    pointerType: string | null
  } | null>(null)
  const keyboardLinkActivationRef = useRef(false)
  const touchStartedAt = useRef<number | null>(null)
  const suppressLongPressClick = useRef(false)
  const swipeGestureRef = useRef<MobileReplyGesture | null>(null)
  const [swipeVisual, setSwipeVisual] = useState({ offset: 0, active: false, crossed: false })
  const avatarMention = useMobileAvatarMention({
    onMention: onMentionAuthor,
    onProfileClick: (event) => {
      onOpenProfile?.(authorName, event, undefined, m.authorId)
    },
  })
  // The Mark/Unmark label needs to know if THIS message is already in the
  // viewer's saved set. That's a single indexed row read, fired lazily only
  // while a menu that shows the item is open (never per-row on mount) — so a
  // channel scroll doesn't pre-load mark state for every row. Defaults to
  // "Mark"; flips to "Unmark" silently once the read resolves (no spinner).
  const markMenuOpen = (toolbarOpen || contextOpen || touchMenuOpen) && !!onMark
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
  const linkMenuHandlers = {
    linkTarget,
    onCopyLink: (target: MessageExternalLinkTarget) => {
      void copyMessageExternalLink(target)
    },
    onOpenLink: (target: MessageExternalLinkTarget) => {
      void openMessageExternalLink(target)
    },
  }
  const showMenu = hasMessageMenu(menuHandlers)
  const interactive = !compact && !m.failed && showMenu
  const touchInputCapable = !hoverCapable
  const touchFallbackActive = !desktopMenuInputSeen && touchInputCapable
  // A hybrid device can alternate between mouse and touch. Switching the menu
  // shell after a mouse gesture must not remove the row's touch swipe handler.
  const swipeReplyEnabled = interactive && touchInputCapable && !selectMode && !!onReply
  const activateOverlays = interactive && !activated
    ? (event: React.SyntheticEvent<HTMLElement>) => {
        if (shouldActivateMessageOverlays(event.target)) setActivated(true)
      }
    : undefined
  const activateLinkOrOverlays = interactive && !activated
    ? (event: React.SyntheticEvent<HTMLElement>) => {
        if (messageExternalLinkTargetFromEventTarget(event.target)) {
          setActivated(true)
        } else {
          activateOverlays?.(event)
        }
      }
    : undefined
  const activate = interactive
    ? (event: React.PointerEvent<HTMLElement>) => {
        if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
        const pointerType = messageLinkPointerType(event.nativeEvent)
        if (pointerType === "mouse") {
          // Closing a portal can reveal the stationary mouse over this row and
          // synthesize pointerenter. Do not swap menu shells underneath a focus
          // target that was just restored into the row.
          const activeElement = typeof document === "undefined" ? null : document.activeElement
          if (shouldAdoptDesktopMenuInput(pointerType, event.currentTarget, activeElement)) {
            setDesktopMenuInputSeen(true)
          }
          activateLinkOrOverlays?.(event)
        } else if (hoverCapable) {
          activateOverlays?.(event)
        }
      }
    : undefined
  const activateFromKeyboard = interactive
    ? (event: React.KeyboardEvent<HTMLElement>) => {
        if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
        if (
          (event.key === "Enter" || event.key === " ")
          && !shouldActivateMessageOverlays(event.target)
        ) {
          // Keep nested controls mounted so the browser can dispatch their
          // synthesized click after keydown. For an ordinary external link,
          // the capture handler consumes this modality ref and leaves the
          // click direct; relative/in-app controls remain untouched too.
          keyboardLinkActivationRef.current = !!messageExternalLinkTargetFromEventTarget(event.target)
          return
        }
        keyboardLinkActivationRef.current = false
        setDesktopMenuInputSeen(true)
        activateLinkOrOverlays?.(event)
      }
    : undefined
  // In select mode (multi-share), the whole row is a big toggle target and gets
  // a leading checkbox overlay + a tint when picked. `canShare` rows only —
  // approval/attachment-only rows aren't selectable (nothing to put on the card).
  const selectable = selectMode && canShare
  const reactionAddButton = (
    <button className="grid h-6 w-7 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add reaction">
      <SmilePlus className="size-4" />
    </button>
  )
  const reactionAddPicker = (
    <EmojiPickerPopover side="top" align="start" onPick={(emoji) => onReact?.(emoji)}>
      {hoverCapable
        ? <TooltipTrigger render={reactionAddButton} />
        : reactionAddButton}
    </EmojiPickerPopover>
  )
  const reactionAddControl = activated || !hoverCapable
    ? hoverCapable
      ? (
          <Tooltip>
            {reactionAddPicker}
            <TooltipContent>Add reaction</TooltipContent>
          </Tooltip>
        )
      : reactionAddPicker
    : reactionAddButton
  const row = (
    <div
      className={[
        "group relative -mx-2 flex gap-2 rounded px-2 transition-colors",
        swipeReplyEnabled ? "z-10 touch-pan-y bg-background" : "",
        swipeVisual.active ? "transition-none" : "transition-transform duration-150 ease-out",
        m.grouped ? "py-0" : "mt-3 pt-1.5 pb-0",
        selectable ? "cursor-pointer pl-9" : "",
        selected ? "bg-primary/10" : highlighted ? "bg-primary/10" : selectable ? "hover:bg-accent/40" : "hover:bg-accent/40",
      ].join(" ")}
      style={swipeVisual.offset > 0
        ? { transform: `translate3d(${swipeVisual.offset}px, 0, 0)` }
        : undefined}
      onPointerEnter={activate}
      onPointerDownCapture={interactive
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            keyboardLinkActivationRef.current = false
            const target = messageExternalLinkTargetFromEventTarget(event.target)
            linkPointerRef.current = target && event.button === 0
              ? { href: target.href, pointerType: messageLinkPointerType(event.nativeEvent) }
              : null
          }
        : undefined}
      onPointerCancelCapture={interactive
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            linkPointerRef.current = null
          }
        : undefined}
      onPointerDown={swipeReplyEnabled
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            if (event.pointerType !== "touch") return
            const nested = (event.target as Element).closest?.(
              "button, a, input, textarea, select, [role=button]",
            )
            if (nested || selectionBelongsToRow(window.getSelection(), event.currentTarget)) return
            const gesture = beginMobileReplyGesture(event.clientX, event.clientY)
            if (!gesture) return
            swipeGestureRef.current = gesture
            setSwipeVisual({ offset: 0, active: true, crossed: false })
          }
        : undefined}
      onPointerMove={swipeReplyEnabled
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            const current = swipeGestureRef.current
            if (!current || event.pointerType !== "touch") return
            if (selectionBelongsToRow(window.getSelection(), event.currentTarget)) {
              swipeGestureRef.current = null
              setSwipeVisual({ offset: 0, active: false, crossed: false })
              return
            }
            const next = advanceMobileReplyGesture(current, event.clientX, event.clientY)
            swipeGestureRef.current = next.gesture
            if (next.gesture.intent === "horizontal") {
              if (current.intent !== "horizontal") {
                event.currentTarget.setPointerCapture?.(event.pointerId)
              }
              event.preventDefault()
            }
            if (next.fireHaptic) navigator.vibrate?.(10)
            setSwipeVisual({
              offset: next.gesture.offset,
              active: next.gesture.intent !== "rejected",
              crossed: next.gesture.thresholdCrossed,
            })
          }
        : undefined}
      onPointerUp={swipeReplyEnabled
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            const gesture = swipeGestureRef.current
            if (!gesture || event.pointerType !== "touch") return
            const commit = shouldCommitMobileReply(gesture)
            swipeGestureRef.current = null
            suppressLongPressClick.current = suppressLongPressClick.current
              || shouldSuppressClickAfterMobileReplyGesture(gesture)
            setSwipeVisual({ offset: 0, active: false, crossed: false })
            if (commit) onReply?.()
          }
        : undefined}
      onPointerCancel={swipeReplyEnabled
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            swipeGestureRef.current = null
            suppressLongPressClick.current = true
            setSwipeVisual({ offset: 0, active: false, crossed: false })
          }
        : undefined}
      onFocusCapture={hoverCapable
        ? (event) => {
            if (messageEventBelongsToRow(event.target, event.currentTarget)) activateOverlays?.(event)
          }
        : undefined}
      onKeyDownCapture={activateFromKeyboard}
      onTouchStart={interactive && touchFallbackActive
          ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            touchStartedAt.current = performance.now()
            suppressLongPressClick.current = false
          }
        : undefined}
      onTouchEnd={interactive && touchFallbackActive
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            const startedAt = touchStartedAt.current
            suppressLongPressClick.current = suppressLongPressClick.current || (
              startedAt !== null && performance.now() - startedAt >= 500
            )
            touchStartedAt.current = null
          }
        : undefined}
      onTouchCancel={interactive && touchFallbackActive
          ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            touchStartedAt.current = null
            suppressLongPressClick.current = true
          }
        : undefined}
      onClick={selectable
        ? (event) => {
            if (messageEventBelongsToRow(event.target, event.currentTarget)) onToggleSelect?.()
          }
        : interactive && touchFallbackActive
          ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            const selection = window.getSelection()
            const selectionInsideRow = selectionBelongsToRow(selection, event.currentTarget)
            const controlSelector = "button, a, input, textarea, select, [role=button]"
            const nearestControl = (event.target as Element).closest(controlSelector)
            const composedControl = event.nativeEvent?.composedPath?.().find(
              (target) => target !== event.currentTarget
                && !!(target as Element).matches?.(controlSelector),
            )
            const nestedControl = !!composedControl
              || (!!nearestControl && nearestControl !== event.currentTarget)
            const suppress = shouldSuppressTouchMenuOpen({
              nestedControl,
              selectionInsideRow,
              longPress: suppressLongPressClick.current,
            })
            suppressLongPressClick.current = false
            // The row itself remains non-interactive document content. Only a
            // short tap on its non-control body opens the controlled menu;
            // nested buttons/links and native long-press selection stay intact.
            if (!suppress) {
              setTouchMenuAnchor(createMessageMenuPointAnchor(event.clientX, event.clientY))
              setTouchMenuOpen(true)
            }
          }
        : undefined}
      onClickCapture={interactive
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            const target = messageExternalLinkTargetFromEventTarget(event.target)
            if (!target) {
              linkPointerRef.current = null
              keyboardLinkActivationRef.current = false
              return
            }
            const capturedPointer = linkPointerRef.current?.href === target.href
              ? linkPointerRef.current.pointerType
              : null
            linkPointerRef.current = null
            const keyboardInputSeen = keyboardLinkActivationRef.current
            keyboardLinkActivationRef.current = false
            if (!messageLinkClickUsesMenu({
              clickPointerType: messageLinkPointerType(event.nativeEvent),
              capturedPointerType: capturedPointer,
              hoverCapable,
              desktopInputSeen: desktopMenuInputSeen || keyboardInputSeen,
            })) return

            event.preventDefault()
            event.stopPropagation()
            setLinkTarget(target)
            setTouchMenuAnchor(createMessageMenuPointAnchor(event.clientX, event.clientY))
            setTouchMenuOpen(true)
          }
        : undefined}
      onContextMenuCapture={interactive
        ? (event) => {
            if (!messageEventBelongsToRow(event.target, event.currentTarget)) return
            setLinkTarget(messageExternalLinkTargetFromEventTarget(event.target))
          }
        : undefined}
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
              <span className="shrink-0 font-medium text-foreground/80">@{replyAuthorName}</span>
              <span className="min-w-0 truncate">{stripInlineMarkup(m.replyTo.text)}</span>
            </>
          )}
        </button>
      )}

      <div className="flex gap-3">
        {m.grouped ? (
          <div className="w-10 shrink-0" />
        ) : (
          <button
            {...avatarMention}
            className="shrink-0 self-start"
            aria-label={onMentionAuthor
              ? `Open ${authorName} profile; long press to mention`
              : undefined}
          >
            <Avatar label={authorAvatar} seed={m.authorId} size={40} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!m.grouped && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={(e) => onOpenProfile?.(authorName, e, undefined, m.authorId)}
                className="min-w-0 max-w-full truncate text-[15px] font-semibold hover:underline"
                style={{ color: m.color ?? "var(--foreground)" }}
              >
                {authorName}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>{formatMessageTime(m.createdAt)}</span>
            </div>
          )}
          {m.approval ? (
            <BotApprovalCard approval={m.approval} />
          ) : (
            visibleContent && (
              <MessageBody
                text={visibleContent}
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
                if (a.kind === "image") {
                  const frameStyle = attachmentImageFrameStyle(a.width, a.height)
                  return (
                    <RemoteContentImage
                      key={i}
                      data-testid={tid.messageImage(m.id, i)}
                      src={a.thumbnailUrl ?? a.url}
                      alt={a.name}
                      width={a.width}
                      height={a.height}
                      loading="lazy"
                      onActivate={() => onPreviewImage?.({
                        originalUrl: a.url,
                        thumbnailUrl: a.thumbnailUrl,
                        name: a.name,
                        width: a.width,
                        height: a.height,
                      })}
                      frameClassName="block max-w-full rounded-lg border border-border transition-colors hover:border-primary/40"
                      frameStyle={frameStyle}
                      imageClassName="block rounded-lg object-contain"
                      errorLabel="Attachment failed to load"
                      onReady={onImageLoad ? () => onImageLoad() : undefined}
                    />
                  )
                }
                return <AttachmentCard key={i} attachment={a} onPreview={onPreviewAttachment} />
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
                          <span className="relative block size-5 overflow-hidden rounded-full" aria-hidden>
                            <RemoteIdentityImage
                              src={embed.author.iconUrl}
                              alt=""
                              className="rounded-full"
                              placeholderClassName="rounded-full"
                            />
                          </span>
                        ) : (
                          <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{avatarInitial(embed.author.name)}</span>
                        )}
                        {embed.author.url ? (
                          <MessageExternalLink href={embed.author.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium hover:underline">{embed.author.name}</MessageExternalLink>
                        ) : (
                          <span className="text-xs font-medium">{embed.author.name}</span>
                        )}
                      </div>
                    )}
                    {embed.provider && <div className="text-xs text-muted-foreground">{embed.provider}</div>}
                    {embed.url ? (
                      <MessageExternalLink href={embed.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium text-primary hover:underline">{embed.title}</MessageExternalLink>
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
                      <RemoteContentImage
                        src={embed.image.url}
                        alt="Embed image"
                        width={embed.image.width}
                        height={embed.image.height}
                        loading="lazy"
                        frameClassName="mt-2 w-full max-w-100 rounded-sm"
                        frameStyle={{ aspectRatio: embed.image.width && embed.image.height ? `${embed.image.width}/${embed.image.height}` : "40/21" }}
                        imageClassName="rounded-sm object-cover"
                        errorLabel="Embed image failed to load"
                        onReady={onImageLoad ? () => onImageLoad() : undefined}
                      />
                    )}

                    {embed.footer && (
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {embed.footer.iconUrl && (
                          <span className="relative block size-4 overflow-hidden rounded-full" aria-hidden>
                            <RemoteIdentityImage
                              src={embed.footer.iconUrl}
                              alt=""
                              className="rounded-full"
                              placeholderClassName="rounded-full"
                            />
                          </span>
                        )}
                        <span>{embed.footer.text}</span>
                      </div>
                    )}
                  </div>

                  {embed.thumbnail && (
                    <RemoteContentImage
                      src={embed.thumbnail.url}
                      alt="Embed thumbnail"
                      loading="lazy"
                      frameClassName="ml-3 size-16 shrink-0 rounded-md"
                      imageClassName="rounded-md object-cover"
                      errorLabel="Thumbnail failed to load"
                    />
                  )}
                </article>
              ))}
            </div>
          )}

          {m.reactions && (
            <div className="mt-2">
              <MessageReactions
                messageId={m.id}
                authorName={authorName}
                messagePreview={visibleContent}
                reactions={m.reactions}
                hoverCapable={hoverCapable}
                tooltipActive={activated}
                onToggleReaction={onToggleReaction}
                resolveUserName={resolveUserName}
                trailingControl={reactionAddControl}
              />
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

  // Not interactive → render the bare row. In select mode the row itself is a
  // toggle target, so no action-menu trigger is mounted.
  if (!interactive || selectMode) return row

  // Coarse/touch input: tap opens the existing dropdown menu. Deliberately do
  // not mount ContextMenuTrigger here — its long-press gesture competes with
  // native message-text selection on iOS/Android.
  if (touchFallbackActive || touchMenuOpen) {
    return (
      <DropdownMenu
        open={touchMenuOpen}
        onOpenChange={(open) => {
          setTouchMenuOpen(open)
          if (!open) setLinkTarget(null)
        }}
      >
        <div className="relative">
          {swipeReplyEnabled && (
            <div
              aria-hidden
              data-mobile-reply-affordance
              data-threshold-crossed={swipeVisual.crossed || undefined}
              className="absolute inset-y-0 left-0 z-0 flex w-14 items-center justify-center text-muted-foreground"
              style={{ opacity: Math.min(1, swipeVisual.offset / 48) }}
            >
              <Reply className="size-5" />
            </div>
          )}
          {row}
          <DropdownMenuTrigger
            render={(
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className={`pointer-events-none absolute right-0 size-0 overflow-hidden ${m.grouped ? "top-0" : "top-3"}`}
              />
            )}
          />
        </div>
        <DropdownMenuContent
          anchor={touchMenuAnchor ?? undefined}
          positionMethod="fixed"
          side="bottom"
          align="start"
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className="w-48 select-none"
        >
          <MessageDropdownItems {...menuHandlers} {...linkMenuHandlers} touch />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Not yet activated on desktop → render the bare row (which carries
  // the pointerenter/focus/keydown activation handlers). The row's Base UI
  // ContextMenu root is only mounted once hover/focus has activated it — and a
  // right-click is always preceded by a pointerenter (mouse arriving on the
  // row), and Shift+F10 by focus, so the menu is mounted before it's invoked.
  // (The share-as-image dialog now lives in MessageList — the share button
  // enters multi-select mode; the dialog opens from the select bar there.)
  // In select mode the row is a toggle target — no context menu / toolbar.
  if (!activated) return row
  return (
    <ContextMenu
      onOpenChange={(open) => {
        setContextOpen(open)
        if (!open) setLinkTarget(null)
      }}
    >
      <ContextMenuTrigger className="select-text" render={row} />
      <ContextMenuContent className="w-48">
        <MessageContextItems {...menuHandlers} {...linkMenuHandlers} />
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
    prev.hoverCapable === next.hoverCapable &&
    prev.onOpenThread === next.onOpenThread &&
    prev.onOpenProfile === next.onOpenProfile &&
    prev.onJumpReply === next.onJumpReply &&
    prev.onToggleReaction === next.onToggleReaction &&
    prev.onReact === next.onReact &&
    prev.onReply === next.onReply &&
    prev.onMentionAuthor === next.onMentionAuthor &&
    prev.onPin === next.onPin &&
    prev.onMark === next.onMark &&
    prev.onCreateThread === next.onCreateThread &&
    prev.onCopy === next.onCopy &&
    prev.onEdit === next.onEdit &&
    prev.onRetry === next.onRetry &&
    prev.onDismiss === next.onDismiss &&
    prev.onPreviewImage === next.onPreviewImage &&
    prev.onPreviewAttachment === next.onPreviewAttachment &&
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
