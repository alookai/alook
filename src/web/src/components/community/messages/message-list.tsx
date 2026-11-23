"use client"

import type { ImagePreview } from "@/lib/community/models/message"
import { withImageGallery } from "./image-preview-gallery"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMessageListController } from "./message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { useConversationFooterSlot } from "./conversation-footer-shell"
import type { MessageListProps, ResolvedMessageListProps } from "./message-list-types"
import { renderMessageListRow } from "./message-list-row"
import { MessageListSkeleton, renderMessageListView } from "./message-list-view"
import { VirtualRows } from "./virtual-cursor-list"
import { MessageUpdateMotionContext, useMessageArrivalMotion } from "./message-update-motion"
import { ConversationPresentationContext, useConversationActivity } from "@/contexts/view-activity"

import { MessageRendererContext, MessageRendererError } from "./renderers/message-cell"
import { failMessageRenderer, selectMessageRenderer, useMessageRendererSettings, type MessageRendererSettings } from "./renderers/message-renderer-settings"

export function MessageList(props: MessageListProps) {
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
  const renderer = useMessageRendererSettings(accountId ?? undefined)
  const presentation = useMemo(() => ({ id: renderer.id, component: renderer.component, revision: renderer.revision,
    onError: () => { if (accountId) failMessageRenderer(accountId, renderer.id) },
    onReturnCurrent: () => { if (accountId) void selectMessageRenderer(accountId, "current") },
  }), [accountId, renderer.id, renderer.component, renderer.revision])
  return <MessageRendererContext.Provider value={presentation}>
    <MessageListEntry key={nextMountSlot.generation} {...props} renderer={renderer} onReturnCurrent={presentation.onReturnCurrent} />
  </MessageRendererContext.Provider>
}

function MessageListEntry({
  variant = "channel",
  initialScrollReady = true,
  renderer,
  onReturnCurrent,
  ...props
}: MessageListProps & { renderer: MessageRendererSettings; onReturnCurrent: () => void }) {
  const [presentationAdmitted, setPresentationAdmitted] = useState(false)
  if (renderer.ready && renderer.component && !presentationAdmitted) setPresentationAdmitted(true)
  if (!renderer.ready) return <PendingMessageListSkeleton variant={variant} />
  if (!presentationAdmitted && !renderer.component) return <MessageRendererError onReturnCurrent={onReturnCurrent} />
  return <MessageListOwner {...props} variant={variant} initialScrollReady={initialScrollReady} renderer={renderer} />
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

function MessageListOwner({ variant, initialScrollReady, renderer, ...props }: MessageListProps & {
  variant: "channel" | "dm"
  initialScrollReady: boolean
  renderer: MessageRendererSettings
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
  const controller = useMessageListController(resolvedProps, capsuleHeight, { revision: renderer.revision, available: !!renderer.component })
  const reducedMotion = useReducedMotion()
  const motionActive = resolvedProps.active === true && controller.initialPosition.contentInteractive && !reducedMotion
  useMessageArrivalMotion(controller.items, controller.scrollRef, {
    active: motionActive,
    channel: props.channel,
    entry: props.positionEntry,
    rendererRevision: renderer.revision,
    tailAttached: !props.hasMoreNewer && !props.isFetchingNewer && !props.presentPending,
    viewerId: props.viewerUserId ?? props.positionScope?.proof.viewerId,
  })
  return renderMessageListView(resolvedProps, controller, () => (
    <MessageUpdateMotionContext.Provider value={motionActive ? renderer.revision : null}>
      <VirtualRows
        reactLayout
        items={controller.items}
        virtualizer={controller.virtualizer}
        onLayoutCommit={controller.onRowsLayoutCommit}
        renderItem={(item) => renderMessageListRow(item, resolvedProps, controller)}
      />
    </MessageUpdateMotionContext.Provider>
  ), footerSlot?.target ?? null, footerSlot?.accessoryTarget ?? null, capsuleHeight)
}
