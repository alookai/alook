import { NextResponse } from "next/server"
import { queries, withD1Retry, createLogger } from "@alook/shared"
import type { Database } from "@alook/shared"

const log = createLogger({ service: "community-agent-runner-auth" })

/**
 * The bot identity resolved from a `crk_` runner key — the BOT's own user id,
 * its OWNER's user id, and the machine it's bound to. Consumed by the unified
 * `withCommunityActor` (see community-actor.ts). The legacy `withAgentRunnerAuth`
 * wrapper and the `/api/community/agent/*` route tree it guarded were deleted in
 * plans/22 §9 phase 5 once every bot verb moved onto the unified actor;
 * `resolveBotActor` is the surviving, shared crk_ validator.
 */
export interface ResolvedBotActor {
  botUserId: string
  ownerUserId: string
  machineId: string
}

const RETRY_OPTS = { route: "community-agent-runner-auth" }

function serviceUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "database temporarily unavailable" },
    { status: 503, headers: { "Retry-After": "1" } },
  )
}

/**
 * Run a D1 lookup through `withD1Retry`; on retry-exhaust log the failing
 * step and return a `NextResponse` sentinel the caller can early-return.
 * Every lookup MUST route through this helper so a new step can't
 * accidentally ship with a bare `try/catch` that either swallows the log
 * or converts the 503 into a 401 (which would rotate CLI runner keys).
 */
async function lookupOr503<T>(
  step: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, value: await withD1Retry(fn, RETRY_OPTS) }
  } catch (err) {
    log.warn("d1_lookup_failed", { step, err: err instanceof Error ? err : new Error(String(err)) })
    return { ok: false, response: serviceUnavailable() }
  }
}

/**
 * Resolve a `crk_` runner-key bearer to a bot identity, shared by
 * `withAgentRunnerAuth` and the unified `withCommunityActor`. Returns a
 * 3-variant discriminant:
 *   - `{ kind: "bot", actor }`   — a valid runner key; `actor` is the resolved
 *                                   {botUserId, ownerUserId, machineId}.
 *   - `{ kind: "not_bot" }`      — no `Bearer crk_…` header at all; the caller
 *                                   MAY fall through to another auth path
 *                                   (this is how `withCommunityActor` routes a
 *                                   human request to `withAuth`).
 *   - `{ kind: "error", response }` — a `crk_` bearer that failed to resolve
 *                                   (bad/revoked key, bot inactive, binding
 *                                   mismatch → 401; transient D1 → 503). NEVER
 *                                   falls through — a malformed bot token must
 *                                   not be silently retried as a human.
 *
 * Field mapping (do not invert): `row.userId` is the bot's OWNER; `row.agentId`
 * is the BOT's own user id. `row.doName` is the runner key's own DO-hash,
 * unrelated to wake dispatch — never threaded through.
 *
 * D1-transient failure semantics: each of the 3 D1 reads runs through
 * `withD1Retry`; on retry-exhaust we return 503 + `Retry-After: 1` (RFC 9110
 * §15.6.4). 401 is reserved for real auth failures (bad token, revoked runner
 * key, bot deleted, binding mismatch) — so a transient D1 blip surfaces as
 * "temporarily unavailable" and does NOT trip the CLI's runner-key rotation
 * path (only ever driven by 401).
 */
export async function resolveBotActor(
  db: Database,
  authHeader: string | null,
): Promise<
  | { kind: "bot"; actor: ResolvedBotActor }
  | { kind: "not_bot" }
  | { kind: "error"; response: NextResponse }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { kind: "not_bot" }
  }
  const raw = authHeader.slice(7).trim()
  if (!raw.startsWith("crk_")) {
    return { kind: "not_bot" }
  }

  const rowLookup = await lookupOr503("findActiveAgentRunnerKeyByBearer", () =>
    queries.communityMachine.findActiveAgentRunnerKeyByBearer(db, raw),
  )
  if (!rowLookup.ok) return { kind: "error", response: rowLookup.response }
  const row = rowLookup.value
  if (!row) {
    return { kind: "error", response: NextResponse.json({ error: "runner key revoked or unknown" }, { status: 401 }) }
  }

  const botLookup = await lookupOr503("getUserInternal", () =>
    queries.user.getUserInternal(db, row.agentId),
  )
  if (!botLookup.ok) return { kind: "error", response: botLookup.response }
  const botUser = botLookup.value
  if (!botUser || !botUser.isBot || botUser.deletedAt !== null) {
    return { kind: "error", response: NextResponse.json({ error: "bot not found or inactive" }, { status: 401 }) }
  }

  const bindingLookup = await lookupOr503("getBotBinding", () =>
    queries.communityBot.getBotBinding(db, row.agentId),
  )
  if (!bindingLookup.ok) return { kind: "error", response: bindingLookup.response }
  const binding = bindingLookup.value
  if (!binding || binding.machineId !== row.machineId) {
    return { kind: "error", response: NextResponse.json({ error: "bot binding mismatch" }, { status: 401 }) }
  }

  return {
    kind: "bot",
    actor: { botUserId: row.agentId, ownerUserId: row.userId, machineId: row.machineId },
  }
}
