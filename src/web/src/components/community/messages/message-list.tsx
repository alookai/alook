"use client"

import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useObservedRegion } from "@/lib/observability/regions"
import { visibleVirtualItems } from "@/lib/observability/virtual-window"
import { useLayoutEffect } from "react"
import { useMessageListController } from "./message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { useConversationFooterSlot } from "./conversation-footer-shell"
import type { MessageListProps, ResolvedMessageListProps } from "./message-list-types"
import { renderMessageListRow } from "./message-list-row"
import { renderMessageListView } from "./message-list-view"
import { VirtualRows } from "./virtual-cursor-list"

export function MessageList({
  variant = "channel",
  initialScrollReady = true,
  ...props
}: MessageListProps) {
  const hoverCapable = useHoverCapable()
  const resolvedProps: ResolvedMessageListProps = {
    ...props,
    messages: isConversationAccessError(props.initialLoadError) ? [] : props.messages,
    variant,
    initialScrollReady,
    hoverCapable,
  }
  const controller = useMessageListController(resolvedProps)
  const visible = visibleVirtualItems(controller.virtualizer).flatMap(item => { const row = controller.items[item.index]; return row?.kind === "message" ? [row.m] : [] })
  useObservedRegion("messages", controller.initialPosition.contentVisible && controller.initialPosition.contentInteractive && !resolvedProps.initialLoadError && (!props.messages.length || visible.length > 0), visible.length)
  const footerSlot = useConversationFooterSlot()
  const setSelectionActive = footerSlot?.setSelectionActive
  useLayoutEffect(() => {
    setSelectionActive?.(controller.selectMode)
    return () => setSelectionActive?.(false)
  }, [controller.selectMode, setSelectionActive])
  return renderMessageListView(resolvedProps, controller, () => (
    <VirtualRows
      items={controller.items}
      virtualizer={controller.virtualizer}
      renderItem={(item, index) => renderMessageListRow(item, resolvedProps, controller, index)}
    />
  ), footerSlot?.target ?? null)
}
