"use client"

import type React from "react"

// `#NUMBER` — channel-scoped message ref. Lazy: always renders as a pill,
// validates on click. The click handler decides:
//   - loaded in the current window → scroll to it
//   - not loaded → open the context sheet (which resolves seq → id server-side)
//
// Range-based rendering was removed on purpose. `seqRange` (min/max) advanced
// on every WS message tick, which busted the `messageRefContext` identity and
// re-rendered every memoized message row on incoming traffic. `onJumpToSeq` is
// built with a latest-ref in `message-list.tsx` and stays reference-stable,
// which keeps `MessageRow`'s memo intact.
export function MessageRefPill({
  children,
  onJumpToSeq,
}: {
  children?: React.ReactNode
  onJumpToSeq?: (seq: number) => void
}) {
  const text = String(children ?? "")
  const seq = parseInt(text.replace(/^#/, ""), 10)

  if (!seq || isNaN(seq) || seq <= 0 || !onJumpToSeq) {
    return <>{text}</>
  }

  return (
    <button
      type="button"
      onClick={() => onJumpToSeq(seq)}
      title={text}
      className="inline-flex items-baseline rounded-[4px] bg-accent px-1 font-medium text-foreground transition-colors hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {text}
    </button>
  )
}
