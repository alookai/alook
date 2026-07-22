import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, withD1Retry, createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"

const log = createLogger({ service: "community-agent-runner-auth" })

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
 * Agent-runner auth middleware for the CLI bridge (`/api/community/agent/*`).
 * Requires `Authorization: Bearer crk_…`. Cloned from `withCommunityDaemonAuth`
 * but needs BOTH a bot identity and an owner identity — both come off the
 * single `findActiveAgentRunnerKeyByBearer` row, no extra DB call required.
 *
 * Field mapping (do not invert): `row.userId` is the bot's OWNER;
 * `row.agentId` is the BOT's own user id. `row.doName` here is the runner
 * key's own DO-hash, unrelated to wake dispatch — never threaded through.
 *
 * D1-transient failure semantics: each of the 3 D1 reads runs through
 * `withD1Retry`; on retry-exhaust we return 503 + `Retry-After: 1` (RFC 9110
 * §15.6.4) so CLI bridges treat it as retryable and do NOT rotate their
 * runner key. 401 is reserved for real auth failures (bad token, revoked
 * runner key, bot deleted, binding mismatch).
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
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "missing or malformed Authorization header" }, { status: 401 })
    }
    const raw = authHeader.slice(7).trim()
    if (!raw.startsWith("crk_")) {
      return NextResponse.json({ error: "invalid runner key" }, { status: 401 })
    }

    const { env } = await getCloudflareContext({ async: true })
    const cloudflareEnv = env as Env
    const db = getDb(cloudflareEnv.DB)

    let row: Awaited<ReturnType<typeof queries.communityMachine.findActiveAgentRunnerKeyByBearer>>
    try {
      row = await withD1Retry(
        () => queries.communityMachine.findActiveAgentRunnerKeyByBearer(db, raw),
        RETRY_OPTS,
      )
    } catch (err) {
      log.warn("d1_lookup_failed", { step: "findActiveAgentRunnerKeyByBearer", err: err instanceof Error ? err : new Error(String(err)) })
      return serviceUnavailable()
    }
    if (!row) {
      return NextResponse.json({ error: "runner key revoked or unknown" }, { status: 401 })
    }

    let botUser: Awaited<ReturnType<typeof queries.user.getUserInternal>>
    try {
      botUser = await withD1Retry(
        () => queries.user.getUserInternal(db, row!.agentId),
        RETRY_OPTS,
      )
    } catch (err) {
      log.warn("d1_lookup_failed", { step: "getUserInternal", err: err instanceof Error ? err : new Error(String(err)) })
      return serviceUnavailable()
    }
    if (!botUser || !botUser.isBot || botUser.deletedAt !== null) {
      return NextResponse.json({ error: "bot not found or inactive" }, { status: 401 })
    }

    let binding: Awaited<ReturnType<typeof queries.communityBot.getBotBinding>>
    try {
      binding = await withD1Retry(
        () => queries.communityBot.getBotBinding(db, row!.agentId),
        RETRY_OPTS,
      )
    } catch (err) {
      log.warn("d1_lookup_failed", { step: "getBotBinding", err: err instanceof Error ? err : new Error(String(err)) })
      return serviceUnavailable()
    }
    if (!binding || binding.machineId !== row.machineId) {
      return NextResponse.json({ error: "bot binding mismatch" }, { status: 401 })
    }

    return handler(req, {
      env: cloudflareEnv,
      botUserId: row.agentId,
      ownerUserId: row.userId,
      machineId: row.machineId,
      params: resolvedParams,
    })
  }
}
