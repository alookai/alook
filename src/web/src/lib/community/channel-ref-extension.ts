import Mention from "@tiptap/extension-mention"
import { PluginKey } from "@tiptap/pm/state"

export type ChannelRefCandidate = {
  id: string // channelId (nanoid)
  name: string // channel display name, for the popup row + in-editor chip
  serverId: string // nanoid
  serverName: string // for the popup row when listing across servers
}

// The shape actually passed to tiptap's `command(props)` — NOT
// `ChannelRefCandidate` (see `buildCommunityChannelRefExtension`'s doc
// comment on the `name` → `label` mapping). Mirrors
// `MentionPopupState.command`'s own mapped-shape typing in
// `mention-extension.ts`.
type ChannelRefCommandProps = { id: string; label: string; serverId: string }

export interface ChannelRefPopupState {
  items: ChannelRefCandidate[]
  selectedIndex: number
  command: ((props: ChannelRefCommandProps) => void) | null
  rect: DOMRect | null
}

export const EMPTY_CHANNEL_REF_STATE: ChannelRefPopupState = {
  items: [],
  selectedIndex: 0,
  command: null,
  rect: null,
}

const CHANNEL_REF_LIMIT = 8

/**
 * Pure ranker — exported for tests. Prefix-then-substring on `name`,
 * case-insensitive, capped at the same limit convention as
 * `rankMentionItems`. No context/DM-empty-list special case is needed here
 * (unlike mentions) — the CALLER decides what candidates to pass in
 * (single-server list for channel/thread composers, cross-server flattened
 * list for DM composers via `useChannelRefDirectory()`); the ranking logic
 * itself is identical either way.
 */
export function rankChannelRefItems(
  candidates: ChannelRefCandidate[],
  query: string,
): ChannelRefCandidate[] {
  const q = query.toLowerCase()
  const prefix: ChannelRefCandidate[] = []
  const substr: ChannelRefCandidate[] = []
  for (const c of candidates) {
    const name = c.name.toLowerCase()
    if (!q || name.startsWith(q)) prefix.push(c)
    else if (name.includes(q)) substr.push(c)
  }
  return [...prefix, ...substr].slice(0, CHANNEL_REF_LIMIT)
}

type SuggestionProps = {
  items: ChannelRefCandidate[]
  command: (props: ChannelRefCommandProps) => void
  clientRect?: (() => DOMRect | null) | null
}

/**
 * Load-bearing rename: the default `Mention` export always creates a node
 * literally named `"mention"` — the composer already registers one
 * `Mention` instance for `@`, so two extensions sharing one node name in the
 * same editor schema is a genuine ProseMirror schema error. `.extend({ name:
 * "channelRef", addAttributes() {...} })` avoids that.
 */
const ChannelRefNode = Mention.extend({
  name: "channelRef",
  addAttributes() {
    return {
      ...this.parent?.(),
      serverId: { default: null },
    }
  },
})

/**
 * Channel-ref extension wired to the community Composer's popup state.
 * Mirrors `buildCommunityMentionExtension` — see that file's doc comment for
 * the overall ref-based-callback rationale.
 *
 * `suggestion.char = "/"`, `allowedPrefixes` left at the library default
 * (`[' ']`, start-of-line included) — exactly the "must follow a space"
 * rule from the spec, no custom `allow` callback needed. The explicit
 * `pluginKey` below is good practice for debugging/introspection but isn't
 * itself load-bearing (anonymous `new PluginKey()` calls already get an
 * auto-incrementing unique suffix in `prosemirror-state`) — the node
 * **name** rename above is what actually avoids the schema collision.
 *
 * `renderText` inserts by id, not display name — ids are nanoid
 * (`[A-Za-z0-9_-]`), always round-trip through `CHANNEL_REF_REGEX` and
 * `resolveChannelRefBase` (which tries id-match first), whereas an arbitrary
 * display name might not (names with spaces/punctuation can't be typed as a
 * compact ref). `renderHTML` shows a compact in-editor chip — channel name
 * only, not the full path — keeping the compose box readable.
 */
export function buildCommunityChannelRefExtension(opts: {
  candidatesRef: { current: ChannelRefCandidate[] }
  popupRef: { current: ChannelRefPopupState }
  setPopup: (
    next: ChannelRefPopupState | ((cur: ChannelRefPopupState) => ChannelRefPopupState),
  ) => void
  // Optional. Kept in sync with the Composer's own query-tracking ref so the
  // "candidates changed while the popup is open" re-rank effect can re-use
  // the query the user actually sees — same purpose as the mention
  // extension's `queryRef`.
  queryRef?: { current: string }
}) {
  const { candidatesRef, popupRef, setPopup, queryRef } = opts

  return ChannelRefNode.configure({
    HTMLAttributes: { class: "channel-ref-highlight" },
    // `serverId` has `default: null`; paste-from-HTML, drag-drop, or any
    // future flow that commits the node without setting it would otherwise
    // emit the literal string `"/null/<channelId>"` on the wire. Fall back
    // to the visible label so the recipient reads a real word instead of
    // a broken pill — degraded, but not misleading. The command flow that
    // DOES set both fields (Enter/Tab on a suggestion) is unaffected.
    renderText: ({ node }) => {
      const { serverId, id, label } = node.attrs as { serverId?: string | null; id?: string; label?: string }
      if (!serverId || !id) return label ? `/${label}` : ""
      return `/${serverId}/${id}`
    },
    renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, `/${node.attrs.label ?? node.attrs.id}`],
    suggestion: {
      char: "/",
      pluginKey: new PluginKey("channelRefSuggestion"),
      items: ({ query }: { query: string }) => {
        if (queryRef) queryRef.current = query
        return rankChannelRefItems(candidatesRef.current, query)
      },
      render: () => ({
        onStart: (props: SuggestionProps) => {
          setPopup({
            items: props.items ?? [],
            selectedIndex: 0,
            command: props.command,
            rect: props.clientRect?.() ?? null,
          })
        },
        onUpdate: (props: SuggestionProps) => {
          setPopup((cur) => ({
            items: props.items ?? [],
            selectedIndex:
              cur.selectedIndex < (props.items?.length ?? 0)
                ? cur.selectedIndex
                : 0,
            command: props.command,
            rect: props.clientRect?.() ?? null,
          }))
        },
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          if (event.isComposing) return false
          const cur = popupRef.current
          if (cur.items.length === 0) return false
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setPopup({
              ...cur,
              selectedIndex: (cur.selectedIndex + 1) % cur.items.length,
            })
            return true
          }
          if (event.key === "ArrowUp") {
            event.preventDefault()
            setPopup({
              ...cur,
              selectedIndex:
                (cur.selectedIndex - 1 + cur.items.length) % cur.items.length,
            })
            return true
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            const item = cur.items[cur.selectedIndex]
            // Explicit field-name mapping — tiptap's `command(props)` inserts
            // a node with `attrs: {...props}` verbatim. `ChannelRefCandidate`
            // has no `label` field, so passing it through as-is would leave
            // `node.attrs.label` `null` and the in-editor chip would render
            // literally as "/null" (the sent message text is unaffected,
            // since `renderText` doesn't read `label` — this only shows up
            // visually in the compose box).
            if (item && cur.command) {
              cur.command({ id: item.id, label: item.name, serverId: item.serverId })
            }
            setPopup(EMPTY_CHANNEL_REF_STATE)
            return true
          }
          if (event.key === "Escape") {
            setPopup(EMPTY_CHANNEL_REF_STATE)
            return true
          }
          return false
        },
        onExit: () => setPopup(EMPTY_CHANNEL_REF_STATE),
      }),
    },
  })
}
