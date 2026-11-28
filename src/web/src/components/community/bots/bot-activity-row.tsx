"use client"

import type { ReactNode } from "react"
import { BOT_WEBHOOK_PROVIDER_META, type BotWebhookProvider } from "@alook/shared"
import { useIsMobile } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AuditEvent, AuditKind } from "@/lib/community/models/audit"
import {
  formatAlookAuditCommand,
  formatAuditToolName,
} from "@/lib/community/audit-event-summary"

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
  if (kind === "text") return { label: "text", tone: "text-foreground/70" }
  if (kind === "turn_interrupt") return { label: "stop", tone: "text-foreground/70" }
  if (kind === "wake_trigger") return { label: "wake", tone: "text-foreground/70" }
  if (kind === "session_reset") return { label: "reset", tone: "text-foreground/70" }
  if (kind === "nap") return { label: "nap", tone: "text-foreground/70" }
  if (kind === "model_changed") return { label: "model", tone: "text-foreground/70" }
  if (kind === "provider_changed") return { label: "provider", tone: "text-foreground/70" }
  if (kind === "error") return { label: "err", tone: "text-destructive" }
  return { label: "think", tone: "text-muted-foreground/70" }
}

const lifecycleText: Partial<Record<AuditKind, { lead: string; detail: string }>> = {
  turn_interrupt: { lead: "Stop accepted by daemon", detail: "— waiting for the active turn to become idle." },
  session_reset: { lead: "Session reset requested", detail: "— the bot will start a fresh session on its next message." },
  nap: { lead: "Reset its own session", detail: "— the bot napped and will start fresh on its next message." },
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
  const lifecycle = lifecycleText[event.kind]
  if (lifecycle) {
    return (
      <TruncatedAuditLog fullText={`${lifecycle.lead} ${lifecycle.detail}`} data-testid={`bot-activity-event-${event.kind}`}>
        <span>{lifecycle.lead}</span>{" "}<span className="text-muted-foreground">{lifecycle.detail}</span>
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
      channel?: string | null
      seq?: number | null
      senderHandle?: string
      reason?: "unread" | "mention" | "webhook" | "schedule"
      triggerName?: string
      provider?: string
      summary?: string
      title?: string
    } | null
    if (p?.reason === "webhook") {
      const providerLabel =
        p.provider &&
        p.provider !== "generic" &&
        Object.hasOwn(BOT_WEBHOOK_PROVIDER_META, p.provider)
          ? BOT_WEBHOOK_PROVIDER_META[p.provider as BotWebhookProvider].label
          : null
      const triggerName = p.triggerName?.trim() || "Trigger"
      const showProvider = Boolean(
        providerLabel && providerLabel.toLowerCase() !== triggerName.toLowerCase(),
      )
      const source = showProvider ? `${providerLabel} · ${triggerName}` : triggerName
      const summary = p.summary?.trim() || ""
      const detail = summary ? `Triggered by ${source} — ${summary}` : `Triggered by ${source}`
      return (
        <TruncatedAuditLog fullText={detail} data-testid="bot-activity-event-wake_trigger">
          <span className="text-muted-foreground">Triggered by</span>{" "}
          {showProvider ? (
            <>
              {providerLabel} <span className="text-muted-foreground/60">·</span> {triggerName}
            </>
          ) : (
            triggerName
          )}
          {summary ? (
            <>
              {" "}
              <span className="text-muted-foreground/60">—</span>{" "}
              <span className="text-muted-foreground">{summary}</span>
            </>
          ) : null}
        </TruncatedAuditLog>
      )
    }
    if (p?.reason === "schedule") {
      const title = p.title?.trim() || "Scheduled task"
      const channel = p.channel?.trim() || null
      const seqLabel = p.seq != null ? `#${p.seq}` : ""
      const detail = channel
        ? `Scheduled · ${title} in ${channel}${seqLabel ? ` ${seqLabel}` : ""}`
        : `Scheduled · ${title}`
      return (
        <TruncatedAuditLog fullText={detail} data-testid="bot-activity-event-wake_trigger">
          <span className="text-muted-foreground">Scheduled</span>{" "}
          <span className="text-muted-foreground/60">·</span> {title}
          {channel ? (
            <>
              {" "}
              <span className="text-muted-foreground">in</span> {channel}
              {seqLabel ? <span className="text-muted-foreground/70"> {seqLabel}</span> : null}
            </>
          ) : null}
        </TruncatedAuditLog>
      )
    }
    const sender = p?.senderHandle ?? "Sender unavailable"
    const channel = p?.channel ?? "Conversation unavailable"
    const seqLabel = p?.seq != null ? `#${p.seq}` : ""
    const verb = p?.reason === "mention" ? "Mentioned by" : "Woken by"
    const detail = `${verb} ${sender} in ${channel}${seqLabel ? ` ${seqLabel}` : ""}`
    return (
      <TruncatedAuditLog fullText={detail} data-testid="bot-activity-event-wake_trigger">
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
  if (event.kind === "text") {
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid="bot-activity-event-text">
        <TruncatedAuditLog fullText={fullText}>{text || "Text unavailable"}</TruncatedAuditLog>
        {truncated && <span className="shrink-0 text-[11px] text-muted-foreground">Truncated</span>}
      </div>
    )
  }
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
  const mobile = useIsMobile()
  const trigger = (
    <button
      type="button"
      data-activity-tooltip-trigger
      className="block min-h-11 w-full min-w-0 cursor-default rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:min-h-0"
    >
      <span
        className={`block truncate font-mono text-[13px] text-foreground ${className}`}
        {...props}
      >
        {children}
      </span>
    </button>
  )
  if (mobile) return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle className="pr-11">Activity details</DialogTitle>
        <ScrollArea
          viewportProps={{ "data-testid": tid.botActivityDetail }}
          viewportClassName="max-h-[calc(var(--app-overlay-safe-height)-8rem)] whitespace-pre-wrap wrap-break-word font-mono text-xs leading-relaxed"
        >
          {fullText}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
  return (
    <Tooltip>
      <TooltipTrigger closeOnClick={false} render={trigger} />
      <TooltipContent
        role="tooltip"
        side="bottom"
        align="start"
        className="max-w-[min(32rem,calc(var(--app-safe-width)-2rem))] overflow-hidden p-0 font-mono text-[12px] leading-relaxed"
      >
        <ScrollArea
          viewportClassName="max-h-[min(24rem,calc(var(--app-overlay-safe-height)-2rem))] whitespace-pre-wrap wrap-break-word"
          contentClassName="px-3 py-1.5"
        >
          {fullText}
        </ScrollArea>
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
