"use client"

import { useMessageListController } from "./internal/message-list-controller"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import type { MessageListProps, ResolvedMessageListProps } from "./internal/message-list-types"
import { renderMessageListRow } from "./internal/message-list-row"
import { renderMessageListView } from "./internal/message-list-view"
import { VirtualRows } from "@/components/ui/virtual-rows"

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
