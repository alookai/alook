import { Reply, Pin, Share } from "lucide-react"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

// Shared message-action items, rendered for either a ContextMenu (right-click) or a
// DropdownMenu (⋯ toolbar). Callbacks are the reusable contract; the preview wires
// preview-local handlers, the live app wires API mutations.
type Item = { label: string; icon?: typeof Pin; danger?: boolean; onClick?: () => void }

// Menu design (locked spec, uiux #14 — Gus/Alli, "less is more"): ONE flat list, no
// sections/divider. Only the HIGH-FREQUENCY actions carry an icon (Reply, Share) —
// there the icon is a navigation anchor you scan straight to. The low-frequency
// actions (React / Thread / Pin / Copy) are text only: their labels are
// self-explanatory, so an icon adds no recognition value, just noise. To keep every
// label's left edge aligned, the icon-less rows render an icon-width placeholder in
// the icon slot (see `renderItem` below) rather than shifting flush-left.

// Each item renders only when its handler is provided. A surface that can't drive an
// action (e.g. read-only thread/DM rows that don't wire Pin/Select) simply omits it —
// no dead menu entries. The channel list passes every handler → the full menu.
// Order is UNCHANGED from before the redesign (Gus, uiux #19 — don't hoist the iconic
// actions to the top): the only change is WHICH rows carry an icon, not their order.
export function messageMenuItems(handlers: {
  onAddReaction?: () => void
  onReply?: () => void
  onPin?: () => void
  pinned?: boolean
  onMark?: () => void
  marked?: boolean
  onCreateThread?: () => void
  onCopy?: () => void
  onEdit?: () => void
  onShare?: () => void
}): Item[] {
  const items: Item[] = []
  // Reply + Share are high-frequency → keep the icon; the rest are text only (their
  // icon slot becomes an aligning placeholder at render). Original ordering preserved.
  if (handlers.onAddReaction) items.push({ label: "Add Reaction", onClick: handlers.onAddReaction })
  if (handlers.onReply) items.push({ label: "Reply", icon: Reply, onClick: handlers.onReply })
  if (handlers.onCreateThread) items.push({ label: "Create Thread", onClick: handlers.onCreateThread })
  if (handlers.onPin) items.push(handlers.pinned
    ? { label: "Unpin Message", onClick: handlers.onPin }
    : { label: "Pin Message", onClick: handlers.onPin })
  // Text-only like Pin. `marked` may still be resolving when the menu opens
  // (lazy single-row read) — it defaults to false, so the label reads "Mark"
  // and silently flips to "Unmark" once the read lands (no spinner, per Alli).
  if (handlers.onMark) items.push(handlers.marked
    ? { label: "Unmark", onClick: handlers.onMark }
    : { label: "Mark", onClick: handlers.onMark })
  if (handlers.onCopy) items.push({ label: "Copy Text", onClick: handlers.onCopy })
  if (handlers.onEdit) items.push({ label: "Edit Message", onClick: handlers.onEdit })
  if (handlers.onShare) items.push({ label: "Share as Image", icon: Share, onClick: handlers.onShare })
  return items
}

// True when at least one action is available — callers use this to decide whether to
// render the ⋯ trigger / context-menu wrapper at all.
export function hasMessageMenu(handlers: Parameters<typeof messageMenuItems>[0]) {
  return messageMenuItems(handlers).length > 0
}

export type MessageMenuHandlers = Parameters<typeof messageMenuItems>[0]

// The icon slot: the real icon for high-freq rows, or an equal-width empty
// placeholder for text-only rows so every label shares one left edge. The menu
// item's own `gap-2` handles the spacing to the label either way.
function IconSlot({ icon: Icon }: { icon?: Item["icon"] }) {
  return Icon ? <Icon className="size-4" /> : <span className="size-4" aria-hidden />
}

export function MessageContextItems(props: MessageMenuHandlers) {
  return (
    <>
      {messageMenuItems(props).map((it) => (
        <ContextMenuItem key={it.label} onClick={it.onClick} className={it.danger ? "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive" : ""}>
          <IconSlot icon={it.icon} /> {it.label}
        </ContextMenuItem>
      ))}
    </>
  )
}

export function MessageDropdownItems(props: MessageMenuHandlers) {
  return (
    <>
      {messageMenuItems(props).map((it) => (
        <DropdownMenuItem key={it.label} onClick={it.onClick} variant={it.danger ? "destructive" : "default"}>
          <IconSlot icon={it.icon} /> {it.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}
