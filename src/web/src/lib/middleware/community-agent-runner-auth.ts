import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, withD1Retry, createLogger } from "@alook/shared"
import type { Database } from "@alook/shared"
import { getDb } from "@/lib/db"

const log = createLogger({ service: "community-agent-runner-auth" })

/**
 * The bot identity resolved from a `crk_` runner key — the BOT's own user id,
 * its OWNER's user id, and the machine it's bound to. Shared by both
 * `withAgentRunnerAuth` (the legacy `/agent/*` wrapper) and the unified
 * `withCommunityActor` (see community-actor.ts).
 */
export interface ResolvedBotActor {
  botUserId: string
  ownerUserId: string
  machineId: string
}

interface AgentRunnerAuthContext {
  env: Env
  /** The BOT's own user id — `row.agentId` from `findActiveAgentRunnerKeyByBearer`. */
  botUserId: string
  /** The bot's OWNER (the human who ran `mintAgentRunnerKey`) — `row.userId`. */
  ownerUserId: string
  machineId: string
}

export type AgentRunnerAuthenticatedHandler = (
  req: NextRequest,
  ctx: AgentRunnerAuthContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

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

/**
 * Agent-runner auth middleware for the CLI bridge (`/api/community/agent/*`).
 * Requires `Authorization: Bearer crk_…`. Now a thin adapter over the shared
 * `resolveBotActor` — behavior is unchanged: a missing/non-`crk_` bearer 401s
 * here (this wrapper is bot-only, so `not_bot` maps to the same 401 the old
 * inline check returned).
 *
 * NOTE (migration): this wrapper stays live until the last `/agent/*` route is
 * moved onto `withCommunityActor`; then it and the `/agent` tree are deleted
 * together. See plans/22-community-unified-actor-route-unify.md §9.
 */
export function withAgentRunnerAuth(handler: AgentRunnerAuthenticatedHandler) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> | Record<string, string> }
  ) => {
    const resolvedParams = context?.params
      ? context.params instanceof Promise
        ? await context.params
        : context.params
      : undefined

    const authHeader = req.headers.get("Authorization")
    // Preserve the old messages: a missing/malformed Bearer vs a non-crk_
    // bearer 401'd with distinct copy. `resolveBotActor` collapses both to
    // `not_bot`, so re-derive the specific 401 here (bot-only wrapper).
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "missing or malformed Authorization header" }, { status: 401 })
    }
    if (!authHeader.slice(7).trim().startsWith("crk_")) {
      return NextResponse.json({ error: "invalid runner key" }, { status: 401 })
    }

    const { env } = await getCloudflareContext({ async: true })
    const cloudflareEnv = env as Env
    const db = getDb(cloudflareEnv.DB)

    const resolved = await resolveBotActor(db, authHeader)
    if (resolved.kind === "error") return resolved.response
    // `not_bot` is unreachable here (the crk_ guard above already returned), but
    // handle it defensively as the same 401 the guard would have produced.
    if (resolved.kind === "not_bot") {
      return NextResponse.json({ error: "invalid runner key" }, { status: 401 })
    }

    return handler(req, {
      env: cloudflareEnv,
      botUserId: resolved.actor.botUserId,
      ownerUserId: resolved.actor.ownerUserId,
      machineId: resolved.actor.machineId,
      params: resolvedParams,
    })
  }
}
