"use client"

import { useLayoutEffect } from "react"
import { useMessageListController } from "./message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { useConversationFooterSlot } from "./composer-overlay-shell"
import type { MessageListProps, ResolvedMessageListProps } from "./message-list-types"
import { renderMessageListRow } from "./message-list-row"
import { renderMessageListView } from "./message-list-view"
import { VirtualRows } from "./virtual-cursor-list"

export function MessageList({
  variant = "channel",
  initialScrollReady = true,
  composerOverlap = 0,
  ...props
}: MessageListProps) {
  const hoverCapable = useHoverCapable()
  const resolvedProps: ResolvedMessageListProps = {
    ...props,
    composerOverlap,
    variant,
    initialScrollReady,
    hoverCapable,
  }
  const controller = useMessageListController(resolvedProps)
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
      itemKey={(item) => item.key}
      renderItem={(item) => renderMessageListRow(item, resolvedProps, controller)}
    />
  ), footerSlot?.target ?? null)
}
