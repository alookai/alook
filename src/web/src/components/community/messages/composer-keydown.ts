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

const IME_POST_COMPOSITION_GUARD_MS = 500

function isAppleWebKitVendor(): boolean {
  return typeof navigator !== "undefined" && /Apple Computer/.test(navigator.vendor)
}

type ComposerDomKeyDownGuardOptions = {
  now?: () => number
  isSafari?: () => boolean
}

type NativeDeletionSyncResult = "skipped" | "synced" | "declined"

function hasUnreconciledNativeRange(view: EditorView): boolean {
  if (
    view.isDestroyed
    || !view.editable
    || !view.dom.isConnected
    || !view.hasFocus()
    || !(view.state.selection instanceof TextSelection)
    || !view.state.selection.empty
  ) {
    return false
  }
  const native = view.dom.ownerDocument.getSelection()
  return Boolean(
    native
    && native.rangeCount === 1
    && !native.isCollapsed
    && native.anchorNode
    && native.focusNode
    && view.dom.contains(native.anchorNode)
    && view.dom.contains(native.focusNode),
  )
}

function syncNativeDeletionSelection(
  view: EditorView,
  event: KeyboardEvent,
): NativeDeletionSyncResult {
  if (
    (event.key !== "Delete" && event.key !== "Backspace")
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.isComposing || view.composing || view.isDestroyed
    || !view.editable || !view.dom.isConnected || !view.hasFocus()
    || !(view.state.selection instanceof TextSelection)
  ) return "skipped"

  const native = view.dom.ownerDocument.getSelection()
  if (
    !native || native.rangeCount !== 1 || native.isCollapsed
    || !native.anchorNode || !native.focusNode
    || !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)
  ) return "skipped"

  let selection: ReturnType<typeof TextSelection.between>
  try {
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset, 1)
    const head = view.posAtDOM(native.focusNode, native.focusOffset, 1)
    const doc = view.state.doc
    if (anchor < 0 || head < 0 || anchor > doc.content.size || head > doc.content.size) return "declined"
    selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head))
  } catch (error) {
    if (error instanceof RangeError) return "declined"
    throw error
  }
  if (!selection.empty && !selection.eq(view.state.selection)) {
    view.dispatch(view.state.tr.setSelection(selection))
    return "synced"
  }
  return "skipped"
}

/**
 * Runs from ProseMirror's `handleDOMEvents` before `editHandlers.keydown`:
 * 1. Guards Safari/WKWebView's trailing Enter/Tab keydown right after
 *    `compositionend` (prosemirror-view 1.43 removed `inOrNearComposition`
 *    from `editHandlers.keydown`).
 * 2. Prevents prosemirror-view 1.43's eager `domObserver.forceFlush(true)` from
 *    reconciling native DOM ranges during IME deletion, modified Delete/Backspace,
 *    or when `posAtDOM` rejects an invalid mapping with `RangeError`.
 */
export function createComposerDomKeyDownGuard({
  now = () => Date.now(),
  isSafari = isAppleWebKitVendor,
}: ComposerDomKeyDownGuardOptions = {}) {
  let pendingConfirmUntil = 0

  return {
    onCompositionStart() {
      pendingConfirmUntil = 0
    },
    onCompositionEnd() {
      pendingConfirmUntil = isSafari() ? now() + IME_POST_COMPOSITION_GUARD_MS : 0
    },
    onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
      const isDeletionKey = event.key === "Delete" || event.key === "Backspace"

      if (event.isComposing || view.composing) {
        return isDeletionKey
      }

      if (pendingConfirmUntil > 0) {
        const withinWindow = now() <= pendingConfirmUntil
        pendingConfirmUntil = 0
        if (withinWindow && (event.key === "Enter" || event.key === "Tab")) {
          return true
        }
      }

      if (isDeletionKey) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
          return hasUnreconciledNativeRange(view)
        }
        return syncNativeDeletionSelection(view, event) === "declined"
      }

      return false
    },
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
