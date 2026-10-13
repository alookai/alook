import { TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { normalizeConsecutiveTerminalHardBreak } from "./consecutive-hard-break"

type ComposerKeyDownOptions = {
  hoverCapable: boolean
  channelRefOpen: boolean
  isForumThreadBody: boolean
  mentionOpen: boolean
  send: () => void
  liftEmptyBlock: () => boolean
  splitListItem: () => boolean
  undoInputRule: () => boolean
}

function undoComposerInputRuleForKeyDown(
  event: KeyboardEvent,
  options: ComposerKeyDownOptions,
): boolean {
  if (
    options.isForumThreadBody
    || event.isComposing
    || event.altKey
    || event.shiftKey
    || (!event.ctrlKey && !event.metaKey)
    || event.key.toLowerCase() !== "z"
    || !options.undoInputRule()
  ) {
    return false
  }

  event.preventDefault()
  return true
}

function submitComposerForKeyDown(
  event: KeyboardEvent,
  options: ComposerKeyDownOptions,
): boolean {
  if (options.mentionOpen || options.channelRefOpen) return false
  if (options.isForumThreadBody) {
    if (event.key !== "Enter" || !event.shiftKey || event.isComposing) {
      return false
    }
  } else if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    !options.hoverCapable
  ) {
    return false
  }

  event.preventDefault()
  options.send()
  return true
}

function syncNativeDeletionSelection(view: EditorView, event: KeyboardEvent): void {
  if (
    (event.key !== "Delete" && event.key !== "Backspace")
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.isComposing || view.composing || view.isDestroyed
    || !view.editable || !view.dom.isConnected || !view.hasFocus()
    || !(view.state.selection instanceof TextSelection)
  ) return

  const native = view.dom.ownerDocument.getSelection()
  if (
    !native || native.rangeCount !== 1 || native.isCollapsed
    || !native.anchorNode || !native.focusNode
    || !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)
  ) return

  let selection: ReturnType<typeof TextSelection.between>
  try {
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset, 1)
    const head = view.posAtDOM(native.focusNode, native.focusOffset, 1)
    const doc = view.state.doc
    if (anchor < 0 || head < 0 || anchor > doc.content.size || head > doc.content.size) return
    selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head))
  } catch (error) {
    if (error instanceof RangeError) return
    throw error
  }
  if (!selection.empty && !selection.eq(view.state.selection)) {
    view.dispatch(view.state.tr.setSelection(selection))
  }
}

export function handleComposerEditorKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  options: ComposerKeyDownOptions,
): boolean {
  syncNativeDeletionSelection(view, event)
  if (undoComposerInputRuleForKeyDown(event, options)) return true
  const submitted = submitComposerForKeyDown(event, options)
  if (
    submitted
    || options.mentionOpen
    || options.channelRefOpen
    || event.isComposing
  ) {
    return submitted
  }
  if (
    !options.isForumThreadBody
    && options.hoverCapable
    && event.key === "Enter"
    && event.shiftKey
  ) {
    const handled = options.splitListItem() || options.liftEmptyBlock()
    if (handled) {
      event.preventDefault()
      return true
    }
  }
  return normalizeConsecutiveTerminalHardBreak(view, event)
}
