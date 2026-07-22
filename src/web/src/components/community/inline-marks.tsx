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
  label,
}: {
  children?: React.ReactNode
  everyone?: boolean
  onClick?: (e: React.MouseEvent) => void
  // Plain-text label for the native `title` tooltip so a long, truncated
  // mention stays fully readable on hover. Falls back to the string children.
  label?: string
}) {
  const title = label ?? (typeof children === "string" ? children : undefined)
  const className = [
    "inline-block max-w-[12rem] truncate align-bottom rounded-[4px] px-1 font-medium",
    everyone ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
    onClick ? "cursor-pointer transition-colors hover:bg-primary/15 hover:text-primary" : "",
  ].join(" ")
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {children}
      </button>
    )
  }
  return <span title={title} className={className}>{children}</span>
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
  const title = typeof children === "string" ? children : undefined
  const className = [
    "inline-flex max-w-[16rem] items-center gap-1 rounded-lg bg-accent px-1 align-bottom font-medium text-foreground",
    muted ? "opacity-60" : "",
    onClick ? "group/pill cursor-pointer transition-colors hover:bg-primary/15 hover:text-primary" : "",
  ].join(" ")
  const content = (
    <>
      <ChannelIcon className="shrink-0 text-xs" />
      {serverPrefix && (
        <span className="shrink-0 text-muted-foreground transition-colors group-hover/pill:text-primary">{serverPrefix} /</span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {content}
      </button>
    )
  }
  return <span title={title} className={className}>{content}</span>
}

// Server-ref pill — same icon/shape/on-off pattern as `ChannelPill` (reuses
// `ChannelIcon` rather than a distinct server icon, so a bare `/server` ref
// and a `/server/channel` ref read as the same visual family), but for a
// bare `/server` ref (no channel segment) — see `server-ref-pill.tsx`.
export function ServerPill({
  children,
  onClick,
  muted,
}: {
  children?: React.ReactNode
  onClick?: (e: React.MouseEvent) => void
  muted?: boolean
}) {
  const title = typeof children === "string" ? children : undefined
  const className = [
    "inline-flex max-w-[16rem] items-center gap-1 rounded-lg bg-accent px-1 align-bottom font-medium text-foreground",
    muted ? "opacity-60" : "",
    onClick ? "group/pill cursor-pointer transition-colors hover:bg-primary/15 hover:text-primary" : "",
  ].join(" ")
  const content = (
    <>
      <ChannelIcon className="shrink-0 text-xs" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {content}
      </button>
    )
  }
  return <span title={title} className={className}>{content}</span>
}
