import {
  AuditLogCliInvocationPayloadSchema,
  AuditLogToolCallPayloadSchema,
  AuditLogThinkingPayloadSchema,
} from "@alook/shared"

/**
 * Parse a stored audit-event `payload` (JSON in the DB) into the shape the
 * client expects for its `kind`. Kept intentionally lenient — a schema drift
 * (e.g. a row written before a payload shape change) collapses to a null
 * payload rather than 500-ing the whole page.
 */
export function parseAuditLogPayload(
  kind: string,
  raw: string
): unknown {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  switch (kind) {
    case "cli_invocation": {
      const r = AuditLogCliInvocationPayloadSchema.safeParse(json)
      return r.success ? r.data : null
    }
    case "tool_call": {
      const r = AuditLogToolCallPayloadSchema.safeParse(json)
      return r.success ? r.data : null
    }
    case "thinking": {
      const r = AuditLogThinkingPayloadSchema.safeParse(json)
      return r.success ? r.data : null
    }
    default:
      return null
  }
}
