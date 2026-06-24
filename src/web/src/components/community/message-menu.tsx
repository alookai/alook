import { SmilePlus, Reply, Pin, PinOff, MessagesSquare, Copy } from "lucide-react"
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

// Shared message-action items, rendered for either a ContextMenu (right-click) or a
// DropdownMenu (⋯ toolbar). Callbacks are the reusable contract; the preview wires
// preview-local handlers, the live app wires API mutations.
type Item = { label: string; icon?: typeof Pin; danger?: boolean; onClick?: () => void }

// Each item renders only when its handler is provided. A surface that can't drive an
// action (e.g. read-only thread/DM rows that don't wire Pin/Select) simply omits it —
// no dead menu entries. The channel list passes every handler → the full menu.
export function messageMenuItems(handlers: {
  onAddReaction?: () => void
  onReply?: () => void
  onPin?: () => void
  pinned?: boolean
  onCreateThread?: () => void
  onCopy?: () => void
}): Item[] {
  const items: Item[] = []
  if (handlers.onAddReaction) items.push({ label: "Add Reaction", icon: SmilePlus, onClick: handlers.onAddReaction })
  if (handlers.onReply) items.push({ label: "Reply", icon: Reply, onClick: handlers.onReply })
  if (handlers.onCreateThread) items.push({ label: "Create Thread", icon: MessagesSquare, onClick: handlers.onCreateThread })
  if (handlers.onPin) items.push(handlers.pinned
    ? { label: "Unpin Message", icon: PinOff, onClick: handlers.onPin }
    : { label: "Pin Message", icon: Pin, onClick: handlers.onPin })
  if (handlers.onCopy) items.push({ label: "Copy Text", icon: Copy, onClick: handlers.onCopy })
  return items
}

// True when at least one action is available — callers use this to decide whether to
// render the ⋯ trigger / context-menu wrapper at all.
export function hasMessageMenu(handlers: Parameters<typeof messageMenuItems>[0]) {
  return messageMenuItems(handlers).some((it) => it.label !== "sep")
}

export type MessageMenuHandlers = Parameters<typeof messageMenuItems>[0]

export function MessageContextItems(props: MessageMenuHandlers) {
  return (
    <>
      {messageMenuItems(props).map((it, i) =>
        it.label === "sep" ? (
          <ContextMenuSeparator key={i} />
        ) : (
          <ContextMenuItem key={it.label} onClick={it.onClick} className={it.danger ? "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive" : ""}>
            {it.icon && <it.icon className="size-4" />} {it.label}
          </ContextMenuItem>
        ),
      )}
    </>
  )
}

export function MessageDropdownItems(props: MessageMenuHandlers) {
  return (
    <>
      {messageMenuItems(props).map((it, i) =>
        it.label === "sep" ? (
          <DropdownMenuSeparator key={i} />
        ) : (
          <DropdownMenuItem key={it.label} onClick={it.onClick} variant={it.danger ? "destructive" : "default"}>
            {it.icon && <it.icon className="size-4" />} {it.label}
          </DropdownMenuItem>
        ),
      )}
    </>
  )
}
