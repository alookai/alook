// Per-channel-per-server composer draft cache. The community composer remounts
// on every channel/DM switch (`ChannelView`/`DmView` are keyed by id), so its
// in-editor text is otherwise lost on navigate. These helpers persist the
// editor's ProseMirror document (as JSON) under a key scoped to the
// conversation, so returning restores the draft.
//
// Why JSON, not plain text: the composer holds @mention and /channel-ref pills
// as ProseMirror nodes. Plain text flattens them to literal `@label` / `/label`
// strings that restore as inert text, not pills. The JSON doc preserves those
// nodes (with their attrs) losslessly, so a restored draft renders identical
// pills. Attachments/replies are still not cached — text + pills only.
//
// Pure wrappers over localStorage (guarded for SSR/quota) rather than the
// `useLocalStorage` hook: the composer's content lives in the tiptap editor,
// not React state, so it hydrates/persists imperatively at mount/update/send.

const PREFIX = "c-composer-draft:"

export function draftStorageKey(scope: string): string {
  return `${PREFIX}${scope}`
}

// The stored shape is the editor's ProseMirror JSON document. Typed as unknown
// here so this module stays editor-agnostic; the composer casts it to tiptap's
// JSONContent at the call site.
export function readComposerDraft(scope: string): unknown | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(draftStorageKey(scope))
    if (!raw) return null
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function writeComposerDraft(scope: string, doc: unknown | null): void {
  if (typeof window === "undefined") return
  const key = draftStorageKey(scope)
  try {
    // An empty draft (null — the composer passes null when the editor is empty)
    // is the absence of a draft: remove the key so a stale entry never
    // resurfaces and localStorage stays clean.
    if (doc == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(doc))
  } catch {
    /* quota exceeded — silently ignore, same as useLocalStorage */
  }
}

export function clearComposerDraft(scope: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(draftStorageKey(scope))
  } catch {
    /* ignore */
  }
}
