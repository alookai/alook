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

// @mention pill. `everyone` styles @everyone/@here distinctly.
export function MentionPill({ children, everyone }: { children?: React.ReactNode; everyone?: boolean }) {
  return (
    <span
      className={[
        "rounded-[4px] px-1 font-medium",
        everyone ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
      ].join(" ")}
    >
      {children}
    </span>
  )
}

// #channel pill — leading hash icon, strips a literal "#" from the label.
export function ChannelPill({ children }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-accent px-1 font-medium text-foreground">
      <ChannelIcon className="text-xs" />
      {String(children).replace(/^#/, "")}
    </span>
  )
}
