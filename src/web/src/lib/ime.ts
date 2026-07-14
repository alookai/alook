type ComposingEvent = {
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}

export function isImeConfirming(e: ComposingEvent): boolean {
  return e.nativeEvent?.isComposing ?? e.isComposing ?? false
}

type EnterKeyEvent = ComposingEvent & {
  key: string
  shiftKey?: boolean
  preventDefault: () => void
}

export function onEnterSubmit(
  fn: () => void,
  opts?: { onEscape?: () => void; allowShift?: boolean },
) {
  return (e: EnterKeyEvent) => {
    if (isImeConfirming(e)) return
    if (e.key === "Escape") {
      opts?.onEscape?.()
      return
    }
    if (e.key === "Enter") {
      if (!opts?.allowShift && e.shiftKey) return
      e.preventDefault()
      fn()
    }
  }
}
