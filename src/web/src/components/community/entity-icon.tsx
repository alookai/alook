import { ListChevronsUpDown, MessagesSquare } from "lucide-react"
import { ChannelIcon } from "./channel-icon"

/**
 * Every community entity that gets a leading glyph, keyed by its RAW stored
 * type string. `ChannelType` is the full 4-value union (`"text" | "forum" |
 * "post" | "thread"`); this alias mirrors those same values so the raw row
 * value maps straight to a glyph without a lossy cast.
 */
export type EntityKind = "text" | "forum" | "thread" | "post"

type IconComponent = (props: { className?: string }) => React.ReactNode

/**
 * Resolve a community entity kind → its icon component. Prefer `<EntityIcon>`
 * in render paths (the eslint `react-hooks/static-components` rule forbids
 * assigning a component to a variable mid-render); use this only where you
 * genuinely need the component reference (e.g. building a static options list
 * outside the render body).
 */
export function getEntityIcon(kind: EntityKind | undefined): IconComponent {
  switch (kind) {
    case "forum":
      return ListChevronsUpDown
    case "thread":
    case "post":
      return MessagesSquare
    default:
      return ChannelIcon
  }
}

/**
 * The single source of truth mapping a community entity kind → its icon. The
 * list/sidebar is canonical; every other surface (inbox, header, dialogs)
 * routes through here so the same entity never shows two different glyphs.
 *
 *   text | undefined   → ChannelIcon (the custom slash glyph)
 *   forum              → ListChevronsUpDown
 *   thread | post      → MessagesSquare
 *
 * Accepts `className` only — matching `ChannelIcon` — so both `size-*` and
 * `text-*` call sites keep working.
 */
export function EntityIcon({ kind, className }: { kind: EntityKind | undefined; className?: string }) {
  switch (kind) {
    case "forum":
      return <ListChevronsUpDown className={className} />
    case "thread":
    case "post":
      return <MessagesSquare className={className} />
    default:
      return <ChannelIcon className={className} />
  }
}
