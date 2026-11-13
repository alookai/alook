"use client"

import type { ImagePreview } from "@/lib/community/models/message"
import { withImageGallery } from "./image-preview-gallery"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useObservedRegion } from "@/lib/observability/regions"
import { visibleVirtualItems } from "@/lib/observability/virtual-window"
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react"
import { hashKey } from "@tanstack/react-query"
import { conversationListScopeKey } from "@/lib/community/conversation-qualification"
import { useMessageListController } from "./message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { useConversationFooterSlot } from "./conversation-footer-shell"
import type { MessageListProps, ResolvedMessageListProps } from "./message-list-types"
import { renderMessageListRow } from "./message-list-row"
import { MessageListSkeleton, renderMessageListView } from "./message-list-view"
import { VirtualRows } from "./virtual-cursor-list"
import { ConversationPresentationContext, useConversationActivity } from "@/contexts/view-activity"

export function MessageList(props: MessageListProps) {
  return <MessageListEntry key={props.positionScope ? hashKey(conversationListScopeKey(props.positionScope)) : undefined} {...props} />
}

function MessageListEntry({
  variant = "channel",
  initialScrollReady = true,
  ...props
}: MessageListProps) {
  const [admitted, setAdmitted] = useState(false)
  // Local cache readiness mounts the owner; its first geometry settlement controls the skeleton.
  const ready = props.messages.length > 0 && !!(props.initialLoadError || props.targetLoadError)
    || initialScrollReady && (props.messages.length > 0 || !props.loading && !props.initialLoadError)
    || !!props.scrollToMessageId && (props.targetPositionDataState ?? props.positionDataState) === "ready" && props.messages.length > 0
  if (ready && !admitted) setAdmitted(true)
  if (props.positionScope && !admitted && !ready && !props.initialLoadError) return <PendingMessageListSkeleton variant={variant} />
  return <MessageListOwner {...props} variant={variant} initialScrollReady={initialScrollReady} />
}

function PendingMessageListSkeleton({ variant }: { variant: "channel" | "dm" }) {
  const footerSlot = useConversationFooterSlot()
  return <MessageListSkeleton variant={variant} capsuleHeight={footerSlot?.capsuleHeight ?? 0} />
}

function useImageGalleryPreview(messages: MessageListProps["messages"], onPreviewImage: MessageListProps["onPreviewImage"]) {
  const previewContext = useRef({ messages: messages, onPreviewImage: onPreviewImage })
  useLayoutEffect(() => { previewContext.current = { messages: messages, onPreviewImage: onPreviewImage } }, [messages, onPreviewImage])
  return useCallback((image: ImagePreview) => {
    const current = previewContext.current
    current.onPreviewImage?.(withImageGallery(image, current.messages))
  }, [])
}

function MessageListOwner({ variant, initialScrollReady, ...props }: MessageListProps & {
  variant: "channel" | "dm"
  initialScrollReady: boolean
}) {
  const previewImage = useImageGalleryPreview(props.messages, props.onPreviewImage)
  const hoverCapable = useHoverCapable()
  const conversationActive = useConversationActivity()
  const conversationPresented = useContext(ConversationPresentationContext) ?? conversationActive
  const resolvedProps: ResolvedMessageListProps = {
    ...props,
    onPreviewImage: props.onPreviewImage ? previewImage : undefined,
    messages: isConversationAccessError(props.initialLoadError) ? [] : props.messages,
    variant,
    initialScrollReady,
    hoverCapable,
    active: conversationActive && props.active !== false,
    positioningActive: conversationPresented && (props.positioningActive ?? props.active) !== false,
  }
  const footerSlot = useConversationFooterSlot()
  const capsuleHeight = footerSlot?.capsuleHeight ?? 0
  const controller = useMessageListController(resolvedProps, capsuleHeight)
  const visible = visibleVirtualItems(controller.virtualizer).flatMap(item => { const row = controller.items[item.index]; return row?.kind === "message" ? [row.m] : [] })
  useObservedRegion("messages", controller.initialPosition.contentVisible && controller.initialPosition.contentInteractive && !resolvedProps.initialLoadError && (!props.messages.length || visible.length > 0), visible.length, { ...props.observation, wait_reason: props.observation?.wait_reason === "none" && !(controller.initialPosition.contentVisible && controller.initialPosition.contentInteractive) ? "position" : props.observation?.wait_reason })
  return renderMessageListView(resolvedProps, controller, () => (
    <VirtualRows
      reactLayout
      items={controller.items}
      virtualizer={controller.virtualizer}
      onLayoutCommit={controller.onRowsLayoutCommit}
      renderItem={(item) => renderMessageListRow(item, resolvedProps, controller)}
    />
  ), footerSlot?.target ?? null, footerSlot?.accessoryTarget ?? null, capsuleHeight)
}
