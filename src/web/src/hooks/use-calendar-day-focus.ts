import { useEffect, type RefObject } from "react"

export function useCalendarDayFocus(
  ref: RefObject<HTMLButtonElement | null>,
  focused: boolean | undefined,
) {
  useEffect(() => {
    if (focused) ref.current?.focus()
  }, [focused, ref])
}
