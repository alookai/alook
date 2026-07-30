"use client"

import { memo, useCallback } from "react"
import { Message } from "./message"
import type { RenderMsg, OpenProfile } from "./_types"

// A thin, memoized per-row wrapper between the virtualized list and `Message`.
//
// Why it exists: the list's `.map()` used to create a fresh inline arrow for
// every callback of every row on every render (`onReply={() => onReply(m.id)}`
// etc.), which gave `Message` new prop identities each render and defeated its
// memo. This wrapper takes the ID-BASED callbacks straight from the parent
// (which are reference-stable — see MessageList's useCallback bundle) plus the
// message, and binds the per-row (no-arg / emoji-only) handlers ONCE via
// `useCallback` keyed on the id. So `Message` receives stable callbacks and its
// custom-comparator memo can actually bail out. See
// plans/community-switch-perf-optimization.md (WS3).
export interface MessageRowProps {
  m: RenderMsg
  pinned?: boolean
  highlighted?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReactionId?: (id: string, emoji: string) => void
  onReactId?: (id: string, emoji: string) => void
  onReplyId?: (id: string) => void
  onPinId?: (id: string) => void
  onCreateThreadId?: (id: string) => void
  onCopyId?: (id: string) => void
  onRetryId?: (id: string) => void
  onJumpToId?: (id: string) => void
  onPreviewImage?: (name: string) => void
  onDownloadFile?: (name: string) => void
  resolveUserName?: (userId: string) => string
  onImageLoad?: () => void
  // Multi-select share. `selectMode`/`selected` are plain booleans (pass-through);
  // `onToggleSelectId`/`onEnterSelectId` are id-based (stable), bound per-row here.
  selectMode?: boolean
  selected?: boolean
  onToggleSelectId?: (id: string) => void
  onEnterSelectId?: (id: string) => void
}

function MessageRowImpl(props: MessageRowProps) {
  const {
    m, pinned, highlighted, onOpenThread, onOpenProfile,
    onToggleReactionId, onReactId, onReplyId, onPinId, onCreateThreadId,
    onCopyId, onRetryId, onJumpToId, onPreviewImage, onDownloadFile,
    resolveUserName, onImageLoad,
    selectMode, selected, onToggleSelectId, onEnterSelectId,
  } = props
  const id = m.id
  const replyToId = m.replyTo?.id

  // Each bound callback is stable across renders as long as the id-based
  // handler and the id are stable — so `Message`'s memo bails out. Each
  // useCallback takes an inline function (lint requires it) and internally
  // no-ops / short-circuits when its id-based source is absent; we then map an
  // absent source to `undefined` at the prop site so `Message` sees the same
  // "feature off" signal it did before.
  const onToggleReaction = useCallback((emoji: string) => onToggleReactionId?.(id, emoji), [onToggleReactionId, id])
  const onReact = useCallback((emoji: string) => onReactId?.(id, emoji), [onReactId, id])
  const onReply = useCallback(() => onReplyId?.(id), [onReplyId, id])
  const onPin = useCallback(() => onPinId?.(id), [onPinId, id])
  const onCreateThread = useCallback(() => onCreateThreadId?.(id), [onCreateThreadId, id])
  const onCopy = useCallback(() => onCopyId?.(id), [onCopyId, id])
  const onRetry = useCallback(() => onRetryId?.(id), [onRetryId, id])
  const onJumpReply = useCallback(() => { if (replyToId) onJumpToId?.(replyToId) }, [onJumpToId, replyToId])
  const onToggleSelect = useCallback(() => onToggleSelectId?.(id), [onToggleSelectId, id])
  const onEnterSelect = useCallback(() => onEnterSelectId?.(id), [onEnterSelectId, id])

  // Map an absent id-based source to `undefined` so `Message` sees the same
  // "feature off" signal it used to (its interactive/menu logic keys off which
  // handlers are undefined). The bound callbacks above stay reference-stable,
  // and these ternaries are stable too (they only flip when the source appears
  // /disappears, which is rare), so the memo still bails on normal re-renders.
  return (
    <Message
      m={m}
      pinned={pinned}
      highlighted={highlighted}
      onOpenThread={onOpenThread}
      onOpenProfile={onOpenProfile}
      onJumpReply={onJumpToId && replyToId ? onJumpReply : undefined}
      onToggleReaction={onToggleReactionId ? onToggleReaction : undefined}
      onReact={onReactId ? onReact : undefined}
      onReply={onReplyId ? onReply : undefined}
      onPin={onPinId ? onPin : undefined}
      onCreateThread={onCreateThreadId ? onCreateThread : undefined}
      onCopy={onCopyId ? onCopy : undefined}
      onRetry={onRetryId ? onRetry : undefined}
      onPreviewImage={onPreviewImage}
      onDownloadFile={onDownloadFile}
      resolveUserName={resolveUserName}
      onImageLoad={onImageLoad}
      selectMode={selectMode}
      selected={selected}
      onToggleSelect={onToggleSelectId ? onToggleSelect : undefined}
      onEnterSelect={onEnterSelectId ? onEnterSelect : undefined}
    />
  )
}

export const MessageRow = memo(MessageRowImpl)
