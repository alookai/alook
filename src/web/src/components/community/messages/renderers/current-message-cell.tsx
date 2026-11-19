import type { MessageCellPresentationProps } from "./message-cell-types"
import { MessageCellLayout } from "./message-cell-layout"

export function CurrentMessageCell({ slots }: MessageCellPresentationProps) {
  return (
    <MessageCellLayout renderer="current" slots={slots}>
      {slots.header}
      {slots.content}
      {slots.footer}
    </MessageCellLayout>
  )
}
