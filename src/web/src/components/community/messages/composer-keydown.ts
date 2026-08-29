import type { Breakpoint } from "@/hooks/use-mobile"
import type { EditorView } from "@tiptap/pm/view"
import { normalizeConsecutiveTerminalHardBreak } from "./consecutive-hard-break"

type ComposerKeyDownOptions = {
  breakpoint: Breakpoint
  channelRefOpen: boolean
  isForumThreadBody: boolean
  mentionOpen: boolean
  send: () => void
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
    options.breakpoint !== "desktop"
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
  const submitted = submitComposerForKeyDown(event, options)
  if (
    submitted
    || options.mentionOpen
    || options.channelRefOpen
    || event.isComposing
  ) {
    return submitted
  }
  return normalizeConsecutiveTerminalHardBreak(view, event)
}
