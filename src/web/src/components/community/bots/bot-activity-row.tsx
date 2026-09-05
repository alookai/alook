"use client"

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AuditEvent, AuditKind } from "@/hooks/community/use-bot-audit-log"
import {
  formatAlookAuditCommand,
  formatAuditToolName,
} from "@/lib/community/audit-event-summary"

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
 * Every body stays on one line so live appends never shift already-visible
 * rows. Truncated bodies reveal the complete retained log in a tooltip:
 * hover/focus on desktop, tap on mobile.
 */
export function BotActivityRow({ event }: { event: AuditEvent }) {
  return (
    <div
      data-testid="bot-activity-row"
      className="group grid min-h-11 grid-cols-[64px_56px_minmax(0,1fr)] items-center gap-x-3 px-4 hover:bg-accent/30 sm:min-h-0 sm:items-baseline sm:py-1.5"
    >
      <time
        dateTime={event.createdAt}
        title={new Date(event.createdAt).toLocaleString()}
        className="font-mono text-[11px] tabular-nums text-muted-foreground/70"
      >
        {formatClock(event.createdAt)}
      </time>
      <KindTag kind={event.kind} />
      <div className="min-w-0 text-left">
        <RowBody event={event} />
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
  if (kind === "turn_interrupt") return { label: "stop", tone: "text-foreground/70" }
  if (kind === "wake_trigger") return { label: "wake", tone: "text-foreground/70" }
  if (kind === "session_reset") return { label: "reset", tone: "text-foreground/70" }
  if (kind === "nap") return { label: "nap", tone: "text-foreground/70" }
  if (kind === "model_changed") return { label: "model", tone: "text-foreground/70" }
  if (kind === "provider_changed") return { label: "provider", tone: "text-foreground/70" }
  if (kind === "error") return { label: "err", tone: "text-destructive" }
  return { label: "think", tone: "text-muted-foreground/70" }
}

function RowBody({ event }: { event: AuditEvent }) {
  if (event.kind === "cli_invocation") {
    const command = formatAlookAuditCommand(event.payload)
    const subcommand = command.replace(/^alook\s+/, "")
    return (
      <TruncatedAuditLog fullText={command}>
        alook <span className="text-muted-foreground">{subcommand}</span>
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "tool_call") {
    const p = event.payload as { name?: string; target?: string } | null
    const name = formatAuditToolName(event.payload)
    if (p?.target) {
      return (
        <TruncatedAuditLog fullText={`${name} · ${p.target}`}>
          {name} <span className="text-muted-foreground/60">·</span>{" "}
          <span className="text-muted-foreground">{p.target}</span>
        </TruncatedAuditLog>
      )
    }
    return <TruncatedAuditLog fullText={name}>{name}</TruncatedAuditLog>
  }
  if (event.kind === "turn_interrupt") {
    const detail = "Stop accepted by daemon — waiting for the active turn to become idle."
    return (
      <TruncatedAuditLog
        fullText={detail}
        data-testid="bot-activity-event-turn_interrupt"
      >
        <span>Stop accepted by daemon</span>{" "}
        <span className="text-muted-foreground">
          — waiting for the active turn to become idle.
        </span>
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "session_reset") {
    const detail = "Session reset requested — the bot will start a fresh session on its next message."
    return (
      <TruncatedAuditLog
        fullText={detail}
        data-testid="bot-activity-event-session_reset"
      >
        <span>Session reset requested</span>{" "}
        <span className="text-muted-foreground">
          — the bot will start a fresh session on its next message.
        </span>
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "nap") {
    const detail = "Reset its own session — the bot napped and will start fresh on its next message."
    return (
      <TruncatedAuditLog
        fullText={detail}
        data-testid="bot-activity-event-nap"
      >
        <span>Reset its own session</span>{" "}
        <span className="text-muted-foreground">
          — the bot napped and will start fresh on its next message.
        </span>
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "model_changed") {
    const p = event.payload as { from?: string | null; to?: string | null } | null
    // Developer-facing audit surface — print the RAW stored ids (no card-style
    // shortening), with the literal `default` standing in for `null`.
    const from = p?.from ?? "default"
    const to = p?.to ?? "default"
    return (
      <TruncatedAuditLog
        fullText={`${from} → ${to}`}
        data-testid="bot-activity-event-model_changed"
      >
        {from} <span className="text-muted-foreground/60">→</span> {to}
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "provider_changed") {
    const p = event.payload as { from?: string; to?: string } | null
    const from = p?.from ?? "?"
    const to = p?.to ?? "?"
    return (
      <TruncatedAuditLog
        fullText={`${from} → ${to}`}
        data-testid="bot-activity-event-provider_changed"
      >
        {from} <span className="text-muted-foreground/60">→</span> {to}
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "error") {
    const p = event.payload as {
      scope?: string
      code?: string
      message?: string
      model?: string | null
    } | null
    const message = p?.message || "Something went wrong"
    // The code/scope is the machine detail; the model names the common
    // bad-model culprit inline. Both muted so the message reads first.
    const detail = p?.model ? `${p?.code ?? "error"} · ${p.model}` : p?.code ?? p?.scope ?? "error"
    return (
      <TruncatedAuditLog
        fullText={`${message} · ${detail}`}
        data-testid="bot-activity-event-error"
      >
        <span className="text-destructive">{message}</span>{" "}
        <span className="text-muted-foreground/60">·</span>{" "}
        <span className="text-[11px] text-muted-foreground/70">{detail}</span>
      </TruncatedAuditLog>
    )
  }
  if (event.kind === "wake_trigger") {
    const p = event.payload as {
      channel?: string
      seq?: number
      senderHandle?: string
      reason?: "unread" | "mention"
    } | null
    const sender = p?.senderHandle ?? "@unknown"
    const channel = p?.channel ?? "/unknown"
    const seqLabel = p?.seq != null ? `#${p.seq}` : ""
    const verb = p?.reason === "mention" ? "Mentioned by" : "Woken by"
    const detail = `${verb} ${sender} in ${channel}${seqLabel ? ` ${seqLabel}` : ""}`
    return (
      <TruncatedAuditLog fullText={detail}>
        <span className="text-muted-foreground">{verb}</span> {sender}{" "}
        <span className="text-muted-foreground">in</span> {channel}
        {seqLabel ? <span className="text-muted-foreground/70"> {seqLabel}</span> : null}
      </TruncatedAuditLog>
    )
  }
  const p = event.payload as { text?: string; truncated?: boolean; chars?: number } | null
  const text = p?.text ?? ""
  const truncated = p?.truncated ?? false
  const chars = p?.chars ?? countCodepoints(text)
  // The daemon can cap stored thinking text. The tooltip reveals every
  // retained character and states the unavailable remainder honestly.
  const omittedChars = truncated ? Math.max(0, chars - countCodepoints(text)) : 0
  const fullText = omittedChars > 0
    ? `${text}\n… ${omittedChars} character${omittedChars === 1 ? "" : "s"} not retained in the audit log`
    : text
  return (
    <TruncatedAuditLog
      fullText={fullText}
      className="text-[12.5px] text-muted-foreground"
    >
      {text}
    </TruncatedAuditLog>
  )
}

function TruncatedAuditLog({
  children,
  fullText,
  className = "",
  ...props
}: {
  children: ReactNode
  fullText: string
  className?: string
  "data-testid"?: string
}) {
  const triggerId = useId()
  const textRef = useRef<HTMLSpanElement | null>(null)
  const pointerTypeRef = useRef<string | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const element = textRef.current
    if (!element) return
    const measure = () => {
      const nextIsTruncated = element.scrollWidth > element.clientWidth + 1
      setIsTruncated(nextIsTruncated)
      if (!nextIsTruncated) setOpen(false)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fullText])

  const trigger = (
    <button
      type="button"
      disabled={!isTruncated}
      data-activity-tooltip-trigger={isTruncated || undefined}
      onPointerDown={(event) => {
        pointerTypeRef.current = event.pointerType
      }}
      onClick={() => {
        if (
          isTruncated
          && (pointerTypeRef.current === "touch" || pointerTypeRef.current === "pen")
        ) {
          setOpen(true)
        }
      }}
      className="block min-h-11 w-full min-w-0 cursor-default rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:min-h-0"
    >
      <span
        ref={textRef}
        className={`block truncate font-mono text-[13px] text-foreground ${className}`}
        {...props}
      >
        {children}
      </span>
    </button>
  )

  return (
    <Tooltip
      disabled={!isTruncated}
      open={open && isTruncated}
      triggerId={triggerId}
      onOpenChange={setOpen}
    >
      <TooltipTrigger
        id={triggerId}
        disabled={!isTruncated}
        closeOnClick={false}
        render={trigger}
      />
      <TooltipContent
        role="tooltip"
        side="bottom"
        align="start"
        className="thin-scrollbar max-h-[min(24rem,calc(100dvh-2rem))] max-w-[min(32rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap wrap-break-word font-mono text-[12px] leading-relaxed"
      >
        {fullText}
      </TooltipContent>
    </Tooltip>
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
