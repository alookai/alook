import { WS_EVENTS } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleAuditBroadcast({ request, env, url, log }: RouterContext): Promise<Response | null> {
  // POST /internal/broadcast-bot-audit-event — the wake-worker calls this
  // right after `insertBotAuditWakeTrigger` writes a `wake_trigger` row, so
  // the owner's UI receives the audit-event WS frame in the same beat as
  // the D1 insert (matching the daemon-originating path at
  // `ws-durable.ts:906-915`). Reachable ONLY via service binding
  // (`WS_DO_WORKER: Fetcher` in wake-worker's wrangler.toml), so origin is
  // implicitly restricted to same-project workers.
  //
  // Body: { botId, ownerUserId, id, kind, payload, createdAt, sessionId?,
  // launchId? }. Everything except sessionId/launchId is required; the
  // handler validates shape and 400s on anything malformed, then forwards
  // the same `community:bot.audit_event` frame shape used at
  // `ws-durable.ts:906-915` to `broadcast/user/<ownerUserId>`.
  if (url.pathname !== "/internal/broadcast-bot-audit-event" || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const b = (body ?? {}) as {
    botId?: unknown
    ownerUserId?: unknown
    id?: unknown
    kind?: unknown
    payload?: unknown
    createdAt?: unknown
    sessionId?: unknown
    launchId?: unknown
  }
  if (
    typeof b.botId !== "string" ||
    typeof b.ownerUserId !== "string" ||
    typeof b.id !== "string" ||
    typeof b.kind !== "string" ||
    typeof b.createdAt !== "string" ||
    b.payload === undefined
  ) {
    return new Response("invalid payload", { status: 400 })
  }
  // Guard against a future caller shape-drift: only the four kinds the
  // browser understands are broadcastable. An unknown `kind` reaches the
  // owner UI as an untyped row (bot-activity-row.tsx renders it verbatim),
  // so reject at the boundary instead.
  const AUDIT_KINDS = new Set(["cli_invocation", "tool_call", "thinking", "wake_trigger", "session_reset", "model_changed"])
  if (!AUDIT_KINDS.has(b.kind)) {
    return new Response("invalid kind", { status: 400 })
  }
  const frame = {
    type: WS_EVENTS.BOT_AUDIT_EVENT,
    botId: b.botId,
    id: b.id,
    kind: b.kind,
    payload: b.payload,
    sessionId: typeof b.sessionId === "string" ? b.sessionId : null,
    launchId: typeof b.launchId === "string" ? b.launchId : null,
    createdAt: b.createdAt,
  }
  const doId = env.WS_DO.idFromName("user:" + b.ownerUserId)
  const stub = env.WS_DO.get(doId)
  try {
    await stub.fetch(
      new Request("http://internal/broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
      }),
    )
  } catch (err) {
    log.warn("internal_broadcast_bot_audit_event_failed", {
      err: String(err),
      ownerUserId: b.ownerUserId,
      botId: b.botId,
    })
    return new Response("broadcast failed", { status: 503 })
  }
  return new Response(null, { status: 204 })
}
