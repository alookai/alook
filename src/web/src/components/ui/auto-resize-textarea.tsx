import * as React from "react"
import { cn } from "@/lib/utils"

const resize = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
}

const AutoResizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, onChange, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)

  const setRef = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof forwardedRef === "function") forwardedRef(el)
      else if (forwardedRef) forwardedRef.current = el
      resize(el)
    },
    [forwardedRef]
  )

  React.useEffect(() => {
    resize(innerRef.current)
  }, [props.value])

  return (
    <textarea
      ref={setRef}
      className={cn("resize-none overflow-hidden", className)}
      onChange={(e) => {
        resize(e.target)
        onChange?.(e)
      }}
      {...props}
    />
  )
})
AutoResizeTextarea.displayName = "AutoResizeTextarea"

export { AutoResizeTextarea }
