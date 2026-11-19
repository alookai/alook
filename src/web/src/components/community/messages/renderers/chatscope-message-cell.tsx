"use client"

import Message from "@chatscope/chat-ui-kit-react/dist/es/Message"
import type { MessageCellPresentationProps } from "./message-cell-types"
import { MessageCellLayout } from "./message-cell-layout"
import styles from "./chatscope-message-cell.module.css"

export function ChatscopeMessageCell({ message, authorName, timestamp, viewerUserId, grouped, slots }: MessageCellPresentationProps) {
  const outgoing = !!viewerUserId && message.authorId === viewerUserId
  return (
    <MessageCellLayout renderer="chatscope" slots={slots}>
      <Message className={styles.message} model={{ direction: outgoing ? "outgoing" : "incoming", position: grouped ? "last" : "single", type: "custom", sender: authorName, sentTime: timestamp }}>
        <Message.Header>{slots.header}</Message.Header>
        <Message.CustomContent>{slots.content}</Message.CustomContent>
        <Message.Footer>{slots.footer}</Message.Footer>
      </Message>
    </MessageCellLayout>
  )
}
