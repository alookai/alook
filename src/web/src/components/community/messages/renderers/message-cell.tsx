"use client"

import { CurrentMessageCell } from "./current-message-cell"
import type { MessageCellPresentationProps } from "./message-cell-types"

export function MessageCell(props: MessageCellPresentationProps) {
  return <CurrentMessageCell {...props} />
}
