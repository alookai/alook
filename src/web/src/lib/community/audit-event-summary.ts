import type { AuditEvent, AuditKind } from "@/hooks/community/use-bot-audit-log"

const SUMMARY_BY_KIND: Record<AuditKind, string> = {
  cli_invocation: "alook command",
  tool_call: "tool",
  thinking: "Updated its reasoning",
  turn_interrupt: "Stop accepted by daemon",
  wake_trigger: "Woke for a new message",
  session_reset: "Session reset requested",
  nap: "Started a fresh session",
  model_changed: "Model changed",
  provider_changed: "Provider changed",
  error: "Encountered an error",
}

/**
 * Concrete, bounded copy for the compact owner preview.
 *
 * Audit payloads can contain thinking text, filesystem paths, URLs, sender
 * handles, channel refs, model ids, and raw error messages. The preview is a
 * navigation surface rather than the full developer log, so only the safe
 * CLI verb or tool name is surfaced. Targets, arguments, thinking, paths,
 * URLs, and raw errors remain confined to the full audit log.
 */
export function summarizeAuditEvent(
  event: Pick<AuditEvent, "kind"> & Partial<Pick<AuditEvent, "payload">>,
): string {
  if (event.kind === "cli_invocation") return formatAlookAuditCommand(event.payload)
  if (event.kind === "tool_call") return formatAuditToolName(event.payload)
  return SUMMARY_BY_KIND[event.kind]
}

const ALOOK_COMMAND_BY_SUBCOMMAND: Record<string, string> = {
  send: "message send",
  read: "channel history",
  resolve: "channel history",
  reactAdd: "message emoji",
  messagePropertySet: "message property set",
  messagePropertyList: "message property list",
  messagePropertyRemove: "message property remove",
  markSet: "message mark set",
  markRemove: "message mark remove",
  markList: "message mark list",
  channelMember: "channel member",
  attachmentUpload: "message attachment upload",
  attachmentDownload: "message attachment download",
  listMembers: "server member",
  listChannels: "channel list",
  listFriends: "friend list",
  friendRequest: "friend request",
  inboxPull: "inbox pull",
  inboxSnapshot: "inbox pull",
  profileBioUpdate: "setting profile",
  profileAvatarUpdate: "setting profile",
  nap: "nap",
}

export function formatAlookAuditCommand(payload: unknown): string {
  const subcommand = payload && typeof payload === "object" && "subcommand" in payload
    && typeof payload.subcommand === "string"
    ? payload.subcommand
    : null
  if (!subcommand) return "alook command"
  const command = ALOOK_COMMAND_BY_SUBCOMMAND[subcommand] ?? wordsFromCamelCase(subcommand)
  const propertyType = payload && typeof payload === "object" && "propertyType" in payload
    && (payload.propertyType === "emoji" || payload.propertyType === "tag" || payload.propertyType === "mark")
    && (subcommand === "messagePropertySet" || subcommand === "messagePropertyRemove")
    ? payload.propertyType
    : null
  return `alook ${command}${propertyType ? ` ${propertyType}` : ""}`
}

export function formatAuditToolName(payload: unknown): string {
  const name = payload && typeof payload === "object" && "name" in payload
    && typeof payload.name === "string"
    ? payload.name.trim().toLowerCase()
    : ""
  return name || "tool"
}

function wordsFromCamelCase(value: string): string {
  return value.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase()
}

export function formatAuditPreviewTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}
