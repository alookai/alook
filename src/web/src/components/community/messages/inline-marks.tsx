"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import type React from "react"
import { CircleAlert, Link2Off, LoaderCircle, LockKeyhole } from "lucide-react"
import styles from "./inline-marks.module.css"
import { ChannelIcon } from "../channels/channel-icon"

export function Spoiler({ children }: { children?: React.ReactNode }) {
  const [shown, setShown] = useAtom(useCreateAtom(false))
  return (
    <button
      onClick={() => setShown(true)}
      className={[
        "rounded-[4px] px-1 transition-colors",
        shown ? "bg-muted text-foreground" : "bg-foreground/80 text-transparent select-none [&_[data-redacted]]:invisible",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

export function MentionPill({
  children,
  everyone,
  onClick,
  label,
}: {
  children?: React.ReactNode
  everyone?: boolean
  onClick?: (e: React.MouseEvent) => void

  label?: string
}) {
  const title = label ?? (typeof children === "string" ? children : undefined)
  const className = [
    "inline-block max-w-[12rem] truncate align-bottom rounded-[4px] px-1 font-medium",
    everyone ? `${styles.broadcast} bg-primary/15 text-primary` : `${styles.reference} bg-accent text-foreground`,
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
// the pill while loading or when syntax matched without a resolved target;
// `showIcon` lets that unresolved state avoid implying a verified channel.
export function ChannelPill({
  children,
  onClick,
  serverPrefix,
  muted,
  showIcon = true,
  seqSuffix,
  testId,
  state,
  statusLabel,
}: {
  children?: React.ReactNode
  onClick?: (e: React.MouseEvent) => void
  serverPrefix?: string
  muted?: boolean
  showIcon?: boolean
  testId?: string
  state?: "loading" | "ready" | "missing" | "forbidden" | "error"
  statusLabel?: string
  seqSuffix?: number
}) {
  const title = typeof children === "string" ? `${children}${statusLabel ? ` — ${statusLabel}` : ""}` : statusLabel
  const isMsgRef = seqSuffix !== undefined
  const StatusIcon = state === "loading" ? LoaderCircle : state === "missing" ? Link2Off : state === "forbidden" ? LockKeyhole : state === "error" ? CircleAlert : null
  const className = [
    `${styles.reference} inline-flex max-w-[16rem] items-center gap-1 rounded-lg bg-accent px-1 align-bottom font-medium text-foreground`,
    muted ? "opacity-60" : "",
    onClick ? "group/pill cursor-pointer transition-colors hover:bg-primary/15 hover:text-primary" : "",
  ].join(" ")
  const content = (
    <>
      {showIcon && <ChannelIcon className="shrink-0 text-xs" />}
      {StatusIcon && <StatusIcon aria-hidden data-ref-status={state} className={`size-3 shrink-0${state === "loading" ? " animate-spin motion-reduce:animate-none" : ""}`} />}
      {serverPrefix && (
        <span className={`${styles.prefix} shrink-0 text-muted-foreground transition-colors group-hover/pill:text-primary`}>{serverPrefix} /</span>
      )}
      <span className="min-w-0 truncate">{children}</span>
      {isMsgRef && <span className="shrink-0 font-semibold">#{seqSuffix}</span>}
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} aria-label={statusLabel ? title : undefined} className={className} data-testid={testId} data-ref-state={state}>
        {content}
      </button>
    )
  }
  return <span title={title} aria-label={statusLabel ? title : undefined} aria-busy={state === "loading" ? true : undefined} className={className} data-testid={testId} data-ref-state={state}>{content}</span>
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
    `${styles.reference} inline-flex max-w-[16rem] items-center gap-1 rounded-lg bg-accent px-1 align-bottom font-medium text-foreground`,
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
