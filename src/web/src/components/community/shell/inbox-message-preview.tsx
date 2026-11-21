"use client"

import type { MouseEvent } from "react"
import { Message } from "../messages/message"
import { MESSAGE_GROUPED_ROW_PADDING_PX, MESSAGE_ROW_VERTICAL_PADDING_PX } from "@/lib/community/message-list-items"
import type { RenderMsg } from "@/lib/community/models/message"

const interactivePreviewContent = "a,button,input,textarea,select,label,summary,audio[controls],video[controls],[contenteditable=true],[role=button],[role=link],[tabindex]:not([tabindex='-1'])"

export function isInboxPreviewContentClick(event: MouseEvent<HTMLElement>) {
  const { currentTarget, target } = event
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || !(target instanceof Element) || !currentTarget.contains(target)) return false
  const control = target.closest(interactivePreviewContent)
  return (!control || !currentTarget.contains(control)) && currentTarget.ownerDocument.getSelection()?.isCollapsed !== false
}

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
    if (isInboxPreviewContentClick(event)) onOpen()
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
