import type { ReactNode } from "react"
import type { MessageCellPresentationProps, MessageRendererId } from "./message-cell-types"

export function MessageCellLayout({ renderer, slots, children }: Pick<MessageCellPresentationProps, "slots"> & {
  renderer: MessageRendererId
  children: ReactNode
}) {
  return <div className="flex min-w-0 flex-1 flex-col gap-2" data-message-renderer={renderer}>
    {slots.actions}
    {slots.reply}
    <div className="flex gap-2">
      {slots.avatar}
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        {slots.selection}
        {children}
      </div>
    </div>
  </div>
}
