import Mention from "@tiptap/extension-mention"
import type { Editor } from "@tiptap/react"
import { PluginKey } from "@tiptap/pm/state"
import { formatHandle } from "@alook/shared"
import {
  createSuggestionCaretRectResolver,
  type SuggestionCaretAnchorProps,
} from "@/lib/community/suggestion-caret-anchor"

export type ChannelRefCandidate = {
  id: string
  name: string
  serverId: string
  serverName: string
  serverDiscriminator: string // required public server identity suffix
}

export type ChannelRefCommandProps = {
  id: string
  label: string
  serverId: string
  serverName: string
  serverDiscriminator: string
}

export function toChannelRefCandidate(
  server: { id: string; name: string; discriminator: string },
  channel: { id: string; name: string },
): ChannelRefCandidate {
  return {
    id: channel.id,
    name: channel.name,
    serverId: server.id,
    serverName: server.name,
    serverDiscriminator: server.discriminator,
  }
}

export function toChannelRefCommandProps(item: ChannelRefCandidate): ChannelRefCommandProps {
  return {
    id: item.id,
    label: item.name,
    serverId: item.serverId,
    serverName: item.serverName,
    serverDiscriminator: item.serverDiscriminator,
  }
}

export interface ChannelRefPopupState {
  items: ChannelRefCandidate[]
  query?: string
  selectedIndex: number
  command: ((props: ChannelRefCommandProps) => void) | null
  getRect: (() => DOMRect | null) | null
}

export type ChannelRefCandidatePresentation = {
  status: "loading" | "ready" | "empty" | "error"
}

export const EMPTY_CHANNEL_REF_STATE: ChannelRefPopupState = {
  items: [],
  selectedIndex: 0,
  command: null,
  getRect: null,
}

const CHANNEL_REF_LIMIT = 8

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

type SuggestionProps = Omit<SuggestionCaretAnchorProps, "editor"> & {
  editor: Editor
  items: ChannelRefCandidate[]
  query?: string
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
      serverName: { default: null },
      serverDiscriminator: { default: null },
    }
  },
})

/**
 * Suggestions follow a space or start-of-line (Tiptap's default allowedPrefixes).
 * Serialized refs use ref-safe display names and the required server discriminator
 * so the canonical chat grammar can resolve them. Missing names use stored IDs.
 */
export function buildCommunityChannelRefExtension(opts: {
  editorRef: { current: Editor | null }
  canSuggest: (editor: Editor) => boolean
  candidatesRef: { current: ChannelRefCandidate[] }
  popupRef: { current: ChannelRefPopupState }
  onIntentRef?: { current: (() => void) | undefined }
  setPopup: (
    next: ChannelRefPopupState | ((cur: ChannelRefPopupState) => ChannelRefPopupState),
  ) => void
  // Optional. Kept in sync with the Composer's own query-tracking ref so the
  // "candidates changed while the popup is open" re-rank effect can re-use
  // the query the user actually sees — same purpose as the mention
  // extension's `queryRef`.
  queryRef?: { current: string }
}) {
  const { editorRef, canSuggest, candidatesRef, popupRef, onIntentRef, setPopup, queryRef } = opts
  let intentSessionActive = false
  const commandFor = (props: SuggestionProps) => {
    const command: NonNullable<ChannelRefPopupState["command"]> = (value) => {
      if (!canSuggest(props.editor) || popupRef.current.command !== command) return
      props.command(value)
    }
    return command
  }

  return ChannelRefNode.configure({
    HTMLAttributes: { class: "channel-ref-highlight" },
    // `serverId` has `default: null`; paste-from-HTML, drag-drop, or any
    // future flow that commits the node without setting it would otherwise
    // emit the literal string `"/null/<channelId>"` on the wire. Fall back
    // to the visible label so the recipient reads a real word instead of
    // a broken pill — degraded, but not misleading. The command flow that
    // DOES set both fields (Enter/Tab on a suggestion) is unaffected.
    // A public server name is usable only with its discriminator. Malformed
    // pasted nodes fall back to the internal server id rather than emitting an
    // ambiguous bare display name; neither segment emits "null"/"undefined".
    renderText: ({ node }) => {
      const { serverId, serverName, serverDiscriminator, id, label } = node.attrs as {
        serverId?: string | null
        serverName?: string | null
        serverDiscriminator?: string | null
        id?: string | null
        label?: string | null
      }
      const server = serverName && serverDiscriminator
        ? formatHandle(serverName, serverDiscriminator)
        : serverId
      const channel = label || id
      if (!server) return channel ? `/${channel}` : ""
      return channel ? `/${server}/${channel}` : `/${server}`
    },
    renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, `/${node.attrs.label ?? node.attrs.id}`],
    suggestion: {
      char: "/",
      pluginKey: new PluginKey("channelRefSuggestion"),
      allow: ({ editor }) => canSuggest(editor),
      shouldShow: ({ transaction }) => Boolean(popupRef.current.command) || transaction.docChanged || transaction.selectionSet,
      items: ({ query, editor }: { query: string; editor: Editor }) => {
        if (!canSuggest(editor)) return []
        if (!intentSessionActive) {
          intentSessionActive = true
          onIntentRef?.current?.()
        }
        if (queryRef) queryRef.current = query
        return rankChannelRefItems(candidatesRef.current, query)
      },
      render: () => ({
        onStart: (props: SuggestionProps) => {
          if (!canSuggest(props.editor)) return
          setPopup({
            items: props.items ?? [],
            query: props.query ?? "",
            selectedIndex: 0,
            command: commandFor(props),
            getRect: createSuggestionCaretRectResolver(props),
          })
        },
        onUpdate: (props: SuggestionProps) => {
          if (!canSuggest(props.editor) || !popupRef.current.command) return
          setPopup((cur) => ({
            items: props.items ?? [],
            query: props.query ?? "",
            selectedIndex:
              cur.selectedIndex < (props.items?.length ?? 0)
                ? cur.selectedIndex
                : 0,
            command: commandFor(props),
            getRect: createSuggestionCaretRectResolver(props),
          }))
        },
        onKeyDown: ({ event, view }) => {
          const editor = editorRef.current
          if (!editor || !canSuggest(editor) || editor.view !== view) return false
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
            // The command stores attrs verbatim; map the candidate name to label.
            if (item && cur.command) {
              cur.command(toChannelRefCommandProps(item))
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
        onExit: ({ editor }) => {
          if (editorRef.current !== editor) return
          intentSessionActive = false
          if (queryRef) queryRef.current = ""
          setPopup(EMPTY_CHANNEL_REF_STATE)
        },
      }),
    },
  })
}
