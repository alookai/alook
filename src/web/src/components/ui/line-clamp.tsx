"use client"

import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type LineClampProps = Omit<ComponentProps<"span">, "children" | "ref"> & {
  text: string
  maxLines?: number
  ellipsis?: string
  location?: "end" | "middle"
  after?: ReactNode
  textTestId?: string
}

export function LineClamp({
  text,
  maxLines = 2,
  ellipsis = "…",
  location = "end",
  after,
  textTestId,
  className,
  ...props
}: LineClampProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const afterRef = useRef<HTMLSpanElement>(null)
  const lines = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : 2
  const offsets = useMemo(() => typeof Intl.Segmenter === "function" ? [0, ...Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ index, segment }) => index + segment.length,
  )] : null, [text])
  const [fit, setFit] = useState<{ input: string; lines: number; location: string; ellipsis: string; value: string; clamped: boolean; overflow: boolean; fallback: boolean }>()
  const current = fit?.input === text && fit.lines === lines && fit.location === location && fit.ellipsis === ellipsis ? fit : undefined

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !offsets) return
    let active = true
    let frame = 0
    const measure = () => {
      const width = root.getBoundingClientRect().width
      const parent = root.parentNode
      if (!active || !parent || width <= 0) return
      const clone = root.cloneNode(true) as HTMLSpanElement
      clone.removeAttribute("id")
      clone.removeAttribute("data-testid")
      clone.setAttribute("aria-hidden", "true")
      clone.inert = true
      Object.assign(clone.style, {
        position: "absolute", visibility: "hidden", pointerEvents: "none",
        left: "0", top: "0", width: `${width}px`, maxWidth: "none",
        height: "auto", maxHeight: "none", display: "block", overflow: "visible",
      })
      const content = clone.querySelector<HTMLElement>('[data-slot="line-clamp-content"]')!
      const body = clone.querySelector<HTMLElement>('[data-slot="line-clamp-text"]')!
      content.style.display = "inline"
      Object.assign(body.style, { display: "inline", overflow: "visible", WebkitLineClamp: "unset" })
      for (const node of clone.querySelectorAll("[id], [data-testid]")) {
        node.removeAttribute("id")
        node.removeAttribute("data-testid")
      }
      parent.insertBefore(clone, root.nextSibling)
      const fits = (value: string) => {
        body.textContent = value
        const tops: number[] = []
        for (const rect of content.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue
          if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top)
        }
        return tops.length <= lines && content.getBoundingClientRect().width <= width + 0.5
      }
      try {
        let value = text
        const clamped = !fits(text)
        let overflow = false
        let fallback = false
        if (clamped) {
          const candidate = (count: number) => {
            const prefix = location === "middle" ? Math.ceil(count / 2) : count
            const suffix = count - prefix
            return text.slice(0, offsets[prefix]) + ellipsis + (suffix ? text.slice(offsets[offsets.length - 1 - suffix]) : "")
          }
          let low = location === "middle" ? 2 : 0
          let high = offsets.length - 2
          let best: number | undefined
          while (low <= high) {
            const count = Math.floor((low + high) / 2)
            if (fits(candidate(count))) {
              best = count
              low = count + 1
            } else {
              high = count - 1
            }
          }
          fallback = best === undefined
          value = fallback ? "" : candidate(best!)
          overflow = best === undefined && !fits("")
        }
        setFit((previous) => previous?.input === text && previous.lines === lines && previous.location === location && previous.ellipsis === ellipsis && previous.value === value && previous.clamped === clamped && previous.overflow === overflow && previous.fallback === fallback
          ? previous : { input: text, lines, location, ellipsis, value, clamped, overflow, fallback })
      } finally {
        clone.remove()
      }
    }
    const schedule = () => {
      if (!active) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule)
    observer?.observe(root)
    if (afterRef.current) observer?.observe(afterRef.current)
    const fonts = document.fonts
    void fonts?.ready.then(() => { if (active) schedule() })
    fonts?.addEventListener("loadingdone", schedule)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      observer?.disconnect()
      fonts?.removeEventListener("loadingdone", schedule)
    }
  }, [text, lines, ellipsis, location, after, offsets])

  return (
    <span {...props} ref={rootRef} className={cn("block min-w-0 max-w-full", className)} data-clamped={current?.clamped} data-clamp-overflow={current?.overflow || undefined} data-clamp-fallback={current?.fallback ? "insufficient-space" : undefined}>
      {current?.clamped && <span className="sr-only">{text}</span>}
      <span data-slot="line-clamp-content" className={current ? "inline" : "flex items-end"}>
        <span
          aria-hidden={current?.clamped || undefined}
          data-slot="line-clamp-text"
          data-testid={textTestId}
          className="min-w-0 wrap-anywhere"
          style={current ? undefined : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }}
        >
          {current?.value ?? text}
        </span>
        {after != null && <span ref={afterRef} data-slot="line-clamp-after" className="ml-1.5 inline-block shrink-0 whitespace-nowrap">{after}</span>}
      </span>
    </span>
  )
}
