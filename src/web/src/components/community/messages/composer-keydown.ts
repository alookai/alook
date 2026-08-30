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

export function handleComposerEditorKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  options: ComposerKeyDownOptions,
): boolean {
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
