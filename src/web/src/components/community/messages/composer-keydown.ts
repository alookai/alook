import type { Breakpoint } from "@/hooks/use-mobile"

type ComposerKeyDownOptions = {
  breakpoint: Breakpoint
  channelRefOpen: boolean
  isForumThreadBody: boolean
  mentionOpen: boolean
  send: () => void
}

export function handleComposerKeyDown(
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
