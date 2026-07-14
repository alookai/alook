"use client"

import { useState } from "react"
import type { AuditEvent, AuditKind } from "@/hooks/community/use-bot-audit-log"

/**
 * One audit-log entry. Rendered as a 3-column strip:
 *
 *   [ HH:MM:SS ]  [ kind glyph ]  [ body … ]
 *
 * The kind glyph is a two-letter tag in muted mono (`>_`, `Tl`, `~~`) rather
 * than a lucide icon — icons at row scale compete with the body text and
 * make each row feel like a card. A tag is quieter and reads like a log
 * severity column.
 *
 * Height is stable per row (thinking rows collapse to 8 lines by default;
 * expanding grows in-place) so live appends don't shift already-visible
 * rows.
 */
export function BotActivityRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="group grid grid-cols-[64px_56px_1fr] items-baseline gap-x-3 px-4 py-1.5 hover:bg-accent/30">
      <time
        dateTime={event.createdAt}
        title={new Date(event.createdAt).toLocaleString()}
        className="font-mono text-[11px] tabular-nums text-muted-foreground/70"
      >
        {formatClock(event.createdAt)}
      </time>
      <KindTag kind={event.kind} />
      <div className="min-w-0 text-left">
        <RowBody event={event} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      </div>
    </div>
  )
}

function KindTag({ kind }: { kind: AuditKind }) {
  const { label, tone } = kindMeta(kind)
  return (
    <span
      className={`select-none font-mono text-[10px] font-medium uppercase tracking-wider ${tone}`}
      aria-label={label}
    >
      {label}
    </span>
  )
}

function kindMeta(kind: AuditKind): { label: string; tone: string } {
  if (kind === "cli_invocation") return { label: "daemon", tone: "text-foreground/70" }
  if (kind === "tool_call") return { label: "tool", tone: "text-muted-foreground" }
  return { label: "think", tone: "text-muted-foreground/70" }
}

/** Thinking rows show up to this many lines before offering "Show more". */
const THINKING_COLLAPSED_LINES = 8

function RowBody({
  event,
  expanded,
  onToggle,
}: {
  event: AuditEvent
  expanded: boolean
  onToggle: () => void
}) {
  if (event.kind === "cli_invocation") {
    const p = event.payload as { subcommand?: string } | null
    const sub = p?.subcommand ?? "?"
    return (
      <span className="font-mono text-[13px] text-foreground">
        alook <span className="text-muted-foreground">{sub}</span>
      </span>
    )
  }
  if (event.kind === "tool_call") {
    const p = event.payload as { name?: string } | null
    return <span className="font-mono text-[13px] text-foreground">{p?.name ?? "?"}</span>
  }
  const p = event.payload as { text?: string; truncated?: boolean; chars?: number } | null
  const text = p?.text ?? ""
  const truncated = p?.truncated ?? false
  // `chars` from the daemon is the codepoint count of the pre-truncation
  // string; compare against the codepoint count of the shown slice so an
  // emoji-heavy body doesn't over-report the hidden remainder.
  const chars = p?.chars ?? countCodepoints(text)
  const lines = text.split("\n")
  const overflowsLineLimit = lines.length > THINKING_COLLAPSED_LINES
  const shownText = expanded
    ? text
    : overflowsLineLimit
      ? lines.slice(0, THINKING_COLLAPSED_LINES).join("\n")
      : text
  const canExpand = overflowsLineLimit || truncated
  const hiddenLines = overflowsLineLimit ? lines.length - THINKING_COLLAPSED_LINES : 0
  const hiddenChars = truncated ? Math.max(0, chars - countCodepoints(shownText)) : 0
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="whitespace-pre-wrap wrap-break-word font-mono text-[12.5px] leading-relaxed text-muted-foreground">
        {shownText}
      </div>
      {canExpand && !expanded ? (
        <button
          type="button"
          onClick={onToggle}
          className="self-start text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
        >
          {overflowsLineLimit
            ? `Show ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`
            : `Show ${hiddenChars} more character${hiddenChars === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {expanded && canExpand ? (
        <button
          type="button"
          onClick={onToggle}
          className="self-start text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
        >
          Collapse
        </button>
      ) : null}
    </div>
  )
}

/** Count Unicode codepoints (matches daemon's `truncateThinking` chars). */
function countCodepoints(s: string): number {
  return [...s].length
}

/** HH:MM:SS in local time — the reader is looking at their own workday. */
function formatClock(iso: string): string {
  const d = new Date(iso)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}
