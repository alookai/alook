"use client"

import { useMessageListController } from "./message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
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
    variant,
    initialScrollReady,
    hoverCapable,
  }
  const controller = useMessageListController(resolvedProps)
  return renderMessageListView(resolvedProps, controller, () => (
    <VirtualRows
      items={controller.items}
      virtualizer={controller.virtualizer}
      itemKey={(item) => item.key}
      renderItem={(item) => renderMessageListRow(item, resolvedProps, controller)}
    />
  ))
}
