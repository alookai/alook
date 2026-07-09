import Mention from "@tiptap/extension-mention"
import { MENTION_TYPES, type MentionType } from "@alook/shared"
import type { Member } from "@/components/community/_types"

export type MentionContext = "channel" | "thread" | "dm"

type MemberMentionItem = {
  kind: "member"
  id: string
  label: string
  avatar: string
  status: "online" | "offline"
}

export type MentionItem =
  | { kind: MentionType; id: MentionType; label: MentionType }
  | MemberMentionItem

const VIRTUAL_ITEMS: MentionItem[] = MENTION_TYPES.map((t) => ({ kind: t, id: t, label: t }))

const MENTION_LIMIT = 8

// The disambiguated label (`Alex#0002`, set by `rankMentionItems` below) is
// what gets serialized into the message text via `renderText` — the backend
// needs it to resolve the exact user instead of falling back to a first-match
// guess. Humans should never see the number though, so the in-editor chip
// (`renderHTML`) and the rendered pill (message-markdown.tsx) both strip it
// for display only.
function mentionDisplayLabel(label: string): string {
  return label.replace(/#\d{4}$/, "")
}

// Pure ranker — exported for tests. Items are everyone/here followed by
// members, ranked prefix-first then substring. Returns an empty list for DMs:
// a 1:1 conversation has no roster to disambiguate against, and the backend
// (message-handler.ts) explicitly skips mention extraction for DMs anyway, so
// the popover would be pure noise. Capped at MENTION_LIMIT.
export function rankMentionItems(
  members: Member[],
  context: MentionContext,
  query: string,
): MentionItem[] {
  if (context === "dm") return []

  const q = query.toLowerCase()
  const virtual = VIRTUAL_ITEMS.filter((v) => !q || v.label.startsWith(q))

  const sw: MemberMentionItem[] = []
  const inc: MemberMentionItem[] = []
  for (const m of members) {
    const name = m.name.toLowerCase()
    const item: MemberMentionItem = {
      kind: "member",
      id: m.id,
      label: m.name,
      avatar: m.avatar,
      status: m.status,
    }
    if (!q || name.startsWith(q)) sw.push(item)
    else if (name.includes(q)) inc.push(item)
  }

  // Disambiguate same-name members within the ranked window: append the
  // `#0042` discriminator to the label (which is also what gets inserted
  // into the message, via `renderText`) so picking either one resolves to
  // the exact user server-side instead of the backend's first-match
  // fallback. Unique names stay plain — no visual noise for the common
  // case.
  const ranked = [...sw, ...inc]
  const nameCounts = new Map<string, number>()
  for (const item of ranked) {
    const key = item.label.toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const membersByLabel = new Map(members.map((m) => [m.id, m]))
  const disambiguated = ranked.map((item) => {
    const key = item.label.toLowerCase()
    if ((nameCounts.get(key) ?? 0) < 2) return item
    const discriminator = membersByLabel.get(item.id)?.discriminator
    if (!discriminator) return item
    return { ...item, label: `${item.label}#${discriminator}` }
  })

  return [...virtual, ...disambiguated].slice(0, MENTION_LIMIT)
}

// Popup state. `rect` is `clientRect()` from @tiptap/suggestion — it's the
// caret position the popup floats above.
export interface MentionPopupState {
  items: MentionItem[]
  selectedIndex: number
  command: ((props: { id: string; label: string }) => void) | null
  rect: DOMRect | null
}

export const EMPTY_MENTION_STATE: MentionPopupState = {
  items: [],
  selectedIndex: 0,
  command: null,
  rect: null,
}

type SuggestionProps = {
  items: MentionItem[]
  command: (props: { id: string; label: string }) => void
  clientRect?: (() => DOMRect | null) | null
}

/**
 * Mention extension wired to the community Composer's popup state.
 *
 * Refs are read inside suggestion callbacks (which fire at runtime, not at
 * extension-build time), so we can build the extension once via useState and
 * still see live `members` and `context`. Mirrors agent-chat/chat-composer.tsx.
 *
 * Keyboard contract: ArrowUp/Down wrap, Enter and Tab pick, Escape closes.
 * IME composition bails — Enter during composition must confirm the IME, not
 * the mention.
 */
export function buildCommunityMentionExtension(opts: {
  membersRef: { current: Member[] }
  contextRef: { current: MentionContext }
  popupRef: { current: MentionPopupState }
  setPopup: (
    next: MentionPopupState | ((cur: MentionPopupState) => MentionPopupState),
  ) => void
  // Optional. Fired (fire-and-forget) with the current query each time the
  // suggestion popup asks for items — the Composer wires this to
  // `useServerMembers.searchMembers` so large-server searches can hit the
  // remote endpoint instead of being capped at the first eagerly-loaded page.
  onSearchMembersRef?: { current: ((q: string) => void) | undefined }
  // Optional. Kept in sync with the Composer's `queryRef` so the current
  // query can be re-used by the re-rank effect when `members` changes while
  // the popup is open. Assignment here (not by the popup consumer) keeps the
  // two paths in agreement.
  queryRef?: { current: string }
}) {
  const { membersRef, contextRef, popupRef, setPopup, onSearchMembersRef, queryRef } = opts

  return Mention.configure({
    HTMLAttributes: { class: "mention-highlight" },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    renderHTML: ({ options, node }) =>
      ["span", options.HTMLAttributes, `@${mentionDisplayLabel(node.attrs.label ?? node.attrs.id ?? "")}`],
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => {
        if (queryRef) queryRef.current = query
        onSearchMembersRef?.current?.(query)
        return rankMentionItems(membersRef.current, contextRef.current, query)
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
            if (item && cur.command) cur.command({ id: item.id, label: item.label })
            setPopup(EMPTY_MENTION_STATE)
            return true
          }
          if (event.key === "Escape") {
            setPopup(EMPTY_MENTION_STATE)
            return true
          }
          return false
        },
        onExit: () => setPopup(EMPTY_MENTION_STATE),
      }),
    },
  })
}

/**
 * Standalone-token scan for `@everyone` / `@here`. Used at send time to set
 * `mentionType` on the outgoing POST body so the server fans out to all
 * members. Precedence follows MENTION_TYPES order (everyone wins over here).
 */
export function detectMentionType(text: string): MentionType | undefined {
  if (!text) return undefined
  const ID = /[A-Za-z0-9_]/
  for (const name of MENTION_TYPES) {
    let i = 0
    while (i < text.length) {
      const at = text.indexOf("@" + name, i)
      if (at === -1) break
      const before = at > 0 ? text[at - 1] : undefined
      const after = text[at + 1 + name.length]
      const beforeOk = before === undefined || !ID.test(before)
      const afterOk = after === undefined || !ID.test(after)
      if (beforeOk && afterOk) return name
      i = at + 1
    }
  }
  return undefined
}
