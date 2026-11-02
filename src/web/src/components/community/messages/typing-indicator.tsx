"use client"

import { useEffect, useState } from "react"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"

/** The pill never takes pointer hits (the message under it stays clickable), so
 * hover and press are read from the pointer position and shown as data flags. */
function usePassivePointerFeedback() {
  // Callback ref: the effect re-binds whenever the pill mounts, unmounts or
  // remounts (no typing -> typing -> none -> typing again).
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el) return
    let pressed = false
    const inside = (event: PointerEvent) => {
      const r = el.getBoundingClientRect()
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom
    }
    const onMove = (event: PointerEvent) => {
      const over = inside(event)
      el.toggleAttribute("data-hover", over)
      if (!over && pressed) { pressed = false; el.removeAttribute("data-pressed") }
    }
    const onDown = (event: PointerEvent) => { if (inside(event)) { pressed = true; el.setAttribute("data-pressed", "") } }
    const onUp = () => { pressed = false; el.removeAttribute("data-pressed") }
    window.addEventListener("pointermove", onMove, { passive: true })
    window.addEventListener("pointerdown", onDown, { passive: true })
    window.addEventListener("pointerup", onUp, { passive: true })
    window.addEventListener("pointercancel", onUp, { passive: true })
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [el])
  return setEl
}

export function TypingIndicator({
  names,
  className,
}: {
  names: string[]
  className?: string
}) {
  const ref = usePassivePointerFeedback()
  if (names.length === 0) return null
  const label = names.length === 0
    ? null
    : names.length === 1
      ? <><span className="font-medium text-foreground">{names[0]}</span> is typing…</>
      : names.length <= 3
        ? <><span className="font-medium text-foreground">{names.slice(0, -1).join(", ")} and {names[names.length - 1]}</span> are typing…</>
        : <><span className="font-medium text-foreground">{names.length} people</span> are typing…</>
  return (
    <div
      ref={ref}
      data-testid={tid.typingIndicator}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "pointer-events-none flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-background/90 px-3 text-xs text-muted-foreground shadow-(--e1) backdrop-blur-sm",
        className,
      )}
    >
      <span className="flex shrink-0 gap-1">
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_infinite]" />
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_160ms_infinite]" />
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_320ms_infinite]" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  )
}
