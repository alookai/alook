"use client"

import type { MouseEvent } from "react"
import { Message } from "../messages/message"
import { MESSAGE_GROUPED_ROW_PADDING_PX, MESSAGE_ROW_VERTICAL_PADDING_PX } from "@/lib/community/message-list-items"
import type { RenderMsg } from "@/lib/community/models/message"

export function InboxMessagePreview({
  message,
  testId,
  continuation,
  onOpen,
  onOpenThread,
  paddingTop = MESSAGE_ROW_VERTICAL_PADDING_PX,
  paddingBottom = MESSAGE_ROW_VERTICAL_PADDING_PX,
}: {
  message: RenderMsg
  testId?: string
  continuation?: boolean
  onOpen?: () => void
  onOpenThread?: () => void
  paddingTop?: number
  paddingBottom?: number
}) {
  const openMessage = onOpen && ((event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)
      || !event.currentTarget.contains(event.target)
      || event.target.closest("a,button,input,textarea,select,[role=button],[role=link]")
      || event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false) return
    onOpen()
  })

  const row = continuation ? { ...message, grouped: true } : message
  const top = continuation ? MESSAGE_GROUPED_ROW_PADDING_PX : paddingTop
  return (
    <div
      data-testid={testId}
      className="flow-root min-w-0"
      style={{ paddingBlock: `${top}px ${paddingBottom}px` }}
      onClick={openMessage}
    >
      {onOpen && <button type="button" className="sr-only focus:not-sr-only focus:underline" onClick={onOpen}>Open message</button>}
      <Message m={row} onOpenThread={onOpenThread} readOnly />
    </div>
  )
}
