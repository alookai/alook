import { Selection } from "@tiptap/pm/state"
import { canSplit } from "@tiptap/pm/transform"
import type { EditorView } from "@tiptap/pm/view"

/**
 * Keep blank lines semantically lossless while avoiding the consecutive
 * terminal `<br>` structure associated with the reported multi-line caret
 * paint.
 *
 * One Shift+Enter remains a hard break (`\n`). On the second consecutive
 * Shift+Enter, replace the existing hard break with a paragraph split
 * (`\n\n`). The community send serializer already uses `\n\n` between
 * paragraphs, so the outgoing plain text is unchanged.
 */
export function normalizeConsecutiveTerminalHardBreak(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  if (event.key !== "Enter" || !event.shiftKey || event.isComposing) {
    return false
  }

  const { state } = view
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if (
    !$from.parent.isTextblock
    || $from.parentOffset !== $from.parent.content.size
    || $from.nodeBefore?.type.name !== "hardBreak"
  ) {
    return false
  }

  const splitPos = $from.pos - 1
  let transaction = state.tr.delete(splitPos, $from.pos)
  if (!canSplit(transaction.doc, splitPos)) return false

  transaction = transaction.split(splitPos)
  transaction.setSelection(Selection.near(transaction.doc.resolve(splitPos + 1), 1))
  event.preventDefault()
  view.dispatch(transaction.scrollIntoView())
  return true
}
