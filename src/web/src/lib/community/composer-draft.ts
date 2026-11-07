

//
// Why JSON, not plain text: the composer holds @mention and /channel-ref pills
// as ProseMirror nodes. Plain text flattens them to literal `@label` / `/label`
// strings that restore as inert text, not pills. The JSON doc preserves those
// nodes (with their attrs) losslessly, so a restored draft renders identical
// pills. Attachments/replies are still not cached — text + pills only.
//

const PREFIX = "c-composer-draft:"

export function draftStorageKey(scope: string): string {
  return `${PREFIX}${scope}`
}

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

    if (doc == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(doc))
  } catch {

  }
}

export function clearComposerDraft(scope: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(draftStorageKey(scope))
  } catch {

  }
}
