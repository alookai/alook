"use client"

import { memo, useCallback, useRef, useState } from "react"
import { useMessageMarked } from "@/hooks/community/use-inbox"
import type { FileAttachment, ImagePreview, RenderMsg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import {
  createMessageMenuPointAnchor,
  MessageRowView,
  selectionBelongsToRow,
  shouldSuppressTouchMenuOpen,
} from "./internal/message-row-view"

export interface MessageRowProps {
  m: RenderMsg
  viewerUserId?: string
  hoverCapable: boolean
  pinned?: boolean
  highlighted?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReactionId?: (id: string, emoji: string) => void
  onReactId?: (id: string, emoji: string) => void
  onReplyId?: (id: string) => void
  onPinId?: (id: string) => void
  onMarkId?: (id: string) => void
  onCreateThreadId?: (id: string) => void
  onCopyId?: (id: string) => void
  onEditId?: (id: string) => void
  onRetryId?: (id: string) => void
  onDismissId?: (id: string) => void
  onJumpToId?: (id: string) => void
  onPreviewImage?: (image: ImagePreview) => void
  onPreviewAttachment?: (attachment: FileAttachment) => void
  onDownloadFile?: (url: string, name: string) => void
  resolveUserName?: (userId: string) => string
  onImageLoad?: () => void
  selectMode?: boolean
  selected?: boolean
  onToggleSelectId?: (id: string) => void
  onEnterSelectId?: (id: string) => void
  onShareSingleId?: (id: string) => void
}

function MessageRowImpl(props: MessageRowProps) {
  const {
    m, viewerUserId, hoverCapable, pinned, highlighted, onOpenThread, onOpenProfile,
    onToggleReactionId, onReactId, onReplyId, onPinId, onMarkId, onCreateThreadId,
    onCopyId, onEditId, onRetryId, onDismissId, onJumpToId, onPreviewImage,
    onPreviewAttachment, onDownloadFile, resolveUserName, onImageLoad,
    selectMode, selected, onToggleSelectId, onEnterSelectId, onShareSingleId,
  } = props
  const id = m.id
  const replyToId = m.replyTo?.id
  const [toolbarOpen, setToolbarOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [touchMenuOpen, setTouchMenuOpen] = useState(false)
  const [touchMenuAnchor, setTouchMenuAnchor] = useState<ReturnType<typeof createMessageMenuPointAnchor> | null>(null)
  const [activated, setActivated] = useState(false)
  const touchStartedAt = useRef<number | null>(null)
  const suppressLongPressClick = useRef(false)
  const markMenuOpen = (toolbarOpen || contextOpen || touchMenuOpen) && !!onMarkId
  const markedQuery = useMessageMarked(id, markMenuOpen)

  const onToggleReaction = useCallback((emoji: string) => onToggleReactionId?.(id, emoji), [onToggleReactionId, id])
  const onReact = useCallback((emoji: string) => onReactId?.(id, emoji), [onReactId, id])
  const onReply = useCallback(() => onReplyId?.(id), [onReplyId, id])
  const onPin = useCallback(() => onPinId?.(id), [onPinId, id])
  const onMark = useCallback(() => onMarkId?.(id), [onMarkId, id])
  const onCreateThread = useCallback(() => onCreateThreadId?.(id), [onCreateThreadId, id])
  const onCopy = useCallback(() => onCopyId?.(id), [onCopyId, id])
  const onEdit = useCallback(() => onEditId?.(id), [onEditId, id])
  const onRetry = useCallback(() => onRetryId?.(id), [onRetryId, id])
  const onDismiss = useCallback(() => onDismissId?.(id), [onDismissId, id])
  const onJumpReply = useCallback(() => onJumpToId?.(replyToId!), [onJumpToId, replyToId])
  const onToggleSelect = useCallback(() => onToggleSelectId?.(id), [onToggleSelectId, id])
  const onEnterSelect = useCallback(() => onEnterSelectId?.(id), [onEnterSelectId, id])
  const onShareSingle = useCallback(() => onShareSingleId?.(id), [onShareSingleId, id])
  const onActivate = useCallback(() => setActivated(true), [])
  const onTouchStart = useCallback(() => {
    touchStartedAt.current = performance.now()
    suppressLongPressClick.current = false
  }, [])
  const onTouchEnd = useCallback(() => {
    const startedAt = touchStartedAt.current
    suppressLongPressClick.current = startedAt !== null
      && performance.now() - startedAt >= 500
    touchStartedAt.current = null
  }, [])
  const onTouchCancel = useCallback(() => {
    touchStartedAt.current = null
    suppressLongPressClick.current = true
  }, [])
  const onTouchBodyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const selectionInsideRow = selectionBelongsToRow(window.getSelection(), event.currentTarget)
    const nearestControl = (event.target as Element).closest(
      "button, a, input, textarea, select, [role=button]",
    )
    const nestedControl = !!nearestControl && nearestControl !== event.currentTarget
    const suppress = shouldSuppressTouchMenuOpen({
      nestedControl,
      selectionInsideRow,
      longPress: suppressLongPressClick.current,
    })
    suppressLongPressClick.current = false
    if (suppress) return
    setTouchMenuAnchor(createMessageMenuPointAnchor(event.clientX, event.clientY))
    setTouchMenuOpen(true)
  }, [])

  return (
    <MessageRowView
      m={m}
      viewerUserId={viewerUserId}
      hoverCapable={hoverCapable}
      pinned={pinned}
      highlighted={highlighted}
      onOpenThread={onOpenThread}
      onOpenProfile={onOpenProfile}
      onJumpReply={onJumpToId && replyToId ? onJumpReply : undefined}
      onToggleReaction={onToggleReactionId ? onToggleReaction : undefined}
      onReact={onReactId ? onReact : undefined}
      onReply={onReplyId ? onReply : undefined}
      onPin={onPinId ? onPin : undefined}
      onMark={onMarkId ? onMark : undefined}
      onCreateThread={onCreateThreadId ? onCreateThread : undefined}
      onCopy={onCopyId ? onCopy : undefined}
      onEdit={onEditId ? onEdit : undefined}
      onRetry={onRetryId ? onRetry : undefined}
      onDismiss={onDismissId ? onDismiss : undefined}
      onPreviewImage={onPreviewImage}
      onPreviewAttachment={onPreviewAttachment}
      onDownloadFile={onDownloadFile}
      resolveUserName={resolveUserName}
      onImageLoad={onImageLoad}
      selectMode={selectMode}
      selected={selected}
      onToggleSelect={onToggleSelectId ? onToggleSelect : undefined}
      onEnterSelect={onEnterSelectId ? onEnterSelect : undefined}
      onShareSingle={onShareSingleId ? onShareSingle : undefined}
      marked={markedQuery.data?.marked ?? false}
      markedLoading={markedQuery.isLoading}
      toolbarOpen={toolbarOpen}
      onToolbarOpenChange={setToolbarOpen}
      onContextOpenChange={setContextOpen}
      touchMenuOpen={touchMenuOpen}
      touchMenuAnchor={touchMenuAnchor}
      onTouchMenuOpenChange={setTouchMenuOpen}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onTouchBodyClick={onTouchBodyClick}
      activated={activated}
      onActivate={onActivate}
    />
  )
}

export const MessageRow = memo(MessageRowImpl)
