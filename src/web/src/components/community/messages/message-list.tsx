"use client"

import type { ImagePreview } from "@/lib/community/models/message"
import { withImageGallery } from "./image-preview-gallery"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMessageListController } from "./message-list-controller"
import { useMessageRowWindow } from "@/hooks/community/use-message-row-window"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { useConversationFooterSlot } from "./conversation-footer-shell"
import type { MessageListProps, ResolvedMessageListProps } from "./message-list-types"
import { renderMessageListRow } from "./message-list-row"
import { renderMessageListView } from "./message-list-view"
import { MessageOverlayHostProvider } from "./message-overlay-host"
import { MessageUpdateMotionContext, useMessageArrivalMotion } from "./message-update-motion"
import { ConversationPresentationContext, useConversationActivity } from "@/contexts/view-activity"

export function MessageList({
  variant = "channel",
  initialScrollReady = true,
  ...props
}: MessageListProps) {
  const accountId = props.viewerUserId ?? props.positionScope?.proof.viewerId ?? null
  const resolvedChannelId = props.channelId ?? props.positionScope?.proof.channelId ?? null
  const [mountSlot, setMountSlot] = useState(() => ({
    accountId,
    channelId: resolvedChannelId,
    generation: 0,
  }))
  let nextMountSlot = mountSlot
  if (
    mountSlot.accountId !== accountId
    || (resolvedChannelId !== null && mountSlot.channelId !== null && resolvedChannelId !== mountSlot.channelId)
  ) {
    nextMountSlot = {
      accountId,
      channelId: resolvedChannelId,
      generation: mountSlot.generation + 1,
    }
    setMountSlot(nextMountSlot)
  } else if (mountSlot.channelId === null && resolvedChannelId !== null) {
    nextMountSlot = { ...mountSlot, channelId: resolvedChannelId }
    setMountSlot(nextMountSlot)
  }
  return <MessageListOwner key={nextMountSlot.generation} {...props} variant={variant} initialScrollReady={initialScrollReady} />
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
  const hasAccessError = isConversationAccessError(props.initialLoadError)
  const visibleMessages = useMemo(
    () => (hasAccessError ? [] : props.messages),
    [hasAccessError, props.messages],
  )
  const replierUserIdsByMessageId = useMemo(() => {
    if (!visibleMessages.some((m) => m.decisionCard)) return undefined
    const map = new Map<string, string[]>()
    for (const m of visibleMessages) {
      if (m.failed) continue
      const targetId = m.replyTo?.id
      if (!targetId || !m.authorId) continue
      const list = map.get(targetId)
      if (!list) {
        map.set(targetId, [m.authorId])
      } else if (!list.includes(m.authorId)) {
        list.push(m.authorId)
      }
    }
    return map
  }, [visibleMessages])
  const resolvedProps: ResolvedMessageListProps = {
    ...props,
    onPreviewImage: props.onPreviewImage ? previewImage : undefined,
    messages: visibleMessages,
    variant,
    initialScrollReady,
    hoverCapable,
    replierUserIdsByMessageId,
    active: conversationActive && props.active !== false,
    positioningActive: conversationPresented && (props.positioningActive ?? props.active) !== false,
  }
  const footerSlot = useConversationFooterSlot()
  const capsuleHeight = footerSlot?.capsuleHeight ?? 0
  const controller = useMessageListController(resolvedProps, capsuleHeight)
  const reducedMotion = useReducedMotion()
  const motionActive = resolvedProps.active === true && controller.initialPosition.contentInteractive && !reducedMotion
  useMessageArrivalMotion(controller.items, controller.scrollRef, {
    active: motionActive,
    channel: props.channel,
    entry: props.positionEntry,
    tailAttached: !props.hasMoreNewer && !props.isFetchingNewer && !props.presentPending,
    viewerId: props.viewerUserId ?? props.positionScope?.proof.viewerId,
  })
  const pinnedRowIds = useMemo(
    () => [props.scrollToMessageId, props.initialPositionMessageId, controller.jumped],
    [props.scrollToMessageId, props.initialPositionMessageId, controller.jumped],
  )
  const rowWindow = useMessageRowWindow({
    items: controller.items,
    scrollRef: controller.scrollRef,
    pinnedIds: pinnedRowIds,
  })
  const visibleSlice = rowWindow.windowed
    ? controller.items.slice(rowWindow.startIndex, rowWindow.endIndex)
    : controller.items
  return renderMessageListView(resolvedProps, controller, () => (
    <MessageUpdateMotionContext.Provider value={motionActive}>
      <MessageOverlayHostProvider>
        <div
          data-message-rows
          className="mt-auto flex w-full flex-col"
        >
          {rowWindow.topSpacerHeight > 0 && (
            <div
              aria-hidden="true"
              data-message-window-spacer="top"
              className="shrink-0"
              style={{ height: rowWindow.topSpacerHeight }}
            />
          )}
          {visibleSlice.map((item, offset) => {
            const index = rowWindow.startIndex + offset
            return (
              <div
                key={item.key}
                data-index={index}
                ref={rowWindow.windowed ? (node) => rowWindow.measureRow(item.key, node) : undefined}
                className="w-full"
              >
                {renderMessageListRow(item, resolvedProps, controller)}
              </div>
            )
          })}
          {rowWindow.bottomSpacerHeight > 0 && (
            <div
              aria-hidden="true"
              data-message-window-spacer="bottom"
              className="shrink-0"
              style={{ height: rowWindow.bottomSpacerHeight }}
            />
          )}
          <div
            aria-hidden="true"
            data-message-list-tail
            className="shrink-0"
            style={{ height: controller.tailPaddingEnd }}
          />
        </div>
      </MessageOverlayHostProvider>
    </MessageUpdateMotionContext.Provider>
  ), footerSlot?.target ?? null, footerSlot?.accessoryTarget ?? null, capsuleHeight)
}
