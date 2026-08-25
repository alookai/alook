import type { AuditEvent, AuditKind } from "@/hooks/community/use-bot-audit-log"

const SUMMARY_BY_KIND: Record<AuditKind, string> = {
  cli_invocation: "Ran an Alook command",
  tool_call: "Used a tool",
  thinking: "Updated its reasoning",
  wake_trigger: "Woke for a new message",
  session_reset: "Session reset requested",
  nap: "Started a fresh session",
  model_changed: "Model changed",
  provider_changed: "Provider changed",
  error: "Encountered an error",
}

/**
 * Bounded, payload-free copy for the compact owner preview.
 *
 * Audit payloads can contain thinking text, filesystem paths, URLs, sender
 * handles, channel refs, model ids, and raw error messages. The preview is a
 * navigation surface rather than the full developer log, so it deliberately
 * derives copy from the event kind only.
 */
export function summarizeAuditEvent(event: Pick<AuditEvent, "kind">): string {
  return SUMMARY_BY_KIND[event.kind]
}

export function formatAuditPreviewTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}
