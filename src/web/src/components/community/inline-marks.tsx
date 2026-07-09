"use client"

import { useState } from "react"
import type React from "react"
import { ChannelIcon } from "./channel-icon"

// Pill components the streamdown renderer maps custom tags to (see message-markdown.tsx).

// Spoiler — hidden until clicked.
export function Spoiler({ children }: { children?: React.ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <button
      onClick={() => setShown(true)}
      className={[
        "rounded-[4px] px-1 transition-colors",
        shown ? "bg-muted text-foreground" : "bg-foreground/80 text-transparent select-none",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

// @mention pill. `everyone` styles @everyone/@here distinctly. `onClick` is
// only wired for resolvable member mentions — @everyone/@here have no
// profile to open, so message-markdown.tsx never passes it for those.
export function MentionPill({
  children,
  everyone,
  onClick,
}: {
  children?: React.ReactNode
  everyone?: boolean
  onClick?: (e: React.MouseEvent) => void
}) {
  const className = [
    "rounded-[4px] px-1 font-medium",
    everyone ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
    onClick ? "cursor-pointer hover:underline" : "",
  ].join(" ")
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {children}
      </button>
    )
  }
  return <span className={className}>{children}</span>
}

// Channel-ref pill — leading channel icon + name. `onClick` navigates
// (rendered as a `<button>` when present, a `<span>` otherwise — same
// on/off pattern as `MentionPill`). `serverPrefix` renders a small
// "prefix /" segment before the name for cross-server refs. `muted` dims
// the pill for the "still resolving" state (see `channel-ref-pill.tsx`).
export function ChannelPill({
  children,
  onClick,
  serverPrefix,
  muted,
}: {
  children?: React.ReactNode
  onClick?: (e: React.MouseEvent) => void
  serverPrefix?: string
  muted?: boolean
}) {
  const className = [
    "inline-flex items-center gap-1 rounded-lg bg-accent px-1 font-medium text-foreground",
    muted ? "opacity-60" : "",
    onClick ? "cursor-pointer hover:underline" : "",
  ].join(" ")
  const content = (
    <>
      <ChannelIcon className="text-xs" />
      {serverPrefix && <span className="text-muted-foreground">{serverPrefix} /</span>}
      {children}
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {content}
      </button>
    )
  }
  return <span className={className}>{content}</span>
}
