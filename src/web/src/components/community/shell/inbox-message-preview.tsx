"use client"

import type { MouseEvent } from "react"
import { Message } from "../messages/message"
import { MESSAGE_ROW_VERTICAL_PADDING_PX } from "@/lib/community/message-list-items"
import type { RenderMsg } from "@/lib/community/models/message"

export function InboxMessagePreview({
  message,
  testId,
  onOpen,
  paddingTop = MESSAGE_ROW_VERTICAL_PADDING_PX,
  paddingBottom = MESSAGE_ROW_VERTICAL_PADDING_PX,
}: {
  message: RenderMsg
  testId?: string
  onOpen?: () => void
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

  return (
    <div
      data-testid={testId}
      className="flow-root min-w-0"
      style={{ paddingBlock: `${paddingTop}px ${paddingBottom}px` }}
      onClick={openMessage}
    >
      {onOpen && <button type="button" className="sr-only focus:not-sr-only focus:underline" onClick={onOpen}>Open message</button>}
      <Message m={message} readOnly />
    </div>
  )
}
