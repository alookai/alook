"use client"

import type React from "react"
import { ChevronDown, Globe, Lock, Plus, Settings } from "lucide-react"

export function ChannelCategory({ name, open, onToggle, isPrivate, onSettings, onAddChannel, headerProps, renderHeader, highlighted, children }: {
  name: string
  open: boolean
  onToggle: () => void
  isPrivate?: boolean
  onSettings?: () => void
  onAddChannel?: () => void
  headerProps?: React.ComponentPropsWithRef<"div">
  renderHeader?: (header: React.ReactElement) => React.ReactNode
  highlighted?: boolean
  children: React.ReactNode
}) {
  const header = (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Group: ${name}`}
      aria-expanded={open}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggle() }
      }}
      {...headerProps}
      onClick={onToggle}
      className={`group flex w-full touch-manipulation items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-muted-foreground/80 select-none hover:text-foreground ${headerProps?.className ?? "cursor-pointer"}`}
    >
      {isPrivate ? <Lock aria-label="Private group" className="size-3 shrink-0" /> : <Globe aria-label="Public group" className="size-3 shrink-0" />}
      <span className="flex-1 truncate text-left">{name}</span>
      {onSettings && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSettings() }} className="grid size-4 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100" aria-label={`Category settings for ${name}`}>
          <Settings className="size-3.5" />
        </button>
      )}
      {onAddChannel && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAddChannel() }} className="grid size-4 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100" aria-label={`Create channel in ${name}`}>
          <Plus className="size-3.5" />
        </button>
      )}
      <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
    </div>
  )
  return (
    <>
      {renderHeader ? renderHeader(header) : header}
      {open && <div className={`rounded-md transition-colors ${highlighted ? "bg-accent/40" : ""}`}>{children}</div>}
    </>
  )
}
