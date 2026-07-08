import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"

export interface AgentRunnerAuthContext {
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
 * Steps (plan §2):
 * 1. Extract `Bearer <token>`; reject non-`crk_` → 401.
 * 2. `findActiveAgentRunnerKeyByBearer` → 401 on null.
 * 3. `getUserInternal(row.agentId)` → 401 if null, `!isBot`, or soft-deleted.
 * 4. `getBotBinding(row.agentId)` → 401 if null or machine mismatch
 *    (belt-and-braces; `getBotBinding` returns no owner of its own).
 *
 * Handlers must NEVER read `X-Agent-Id` or a body `agentId` — identity is
 * always `ctx.botUserId` from this middleware.
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

    const row = await queries.communityMachine.findActiveAgentRunnerKeyByBearer(db, raw)
    if (!row) {
      return NextResponse.json({ error: "runner key revoked or unknown" }, { status: 401 })
    }

    const botUser = await queries.user.getUserInternal(db, row.agentId)
    if (!botUser || !botUser.isBot || botUser.deletedAt !== null) {
      return NextResponse.json({ error: "bot not found or inactive" }, { status: 401 })
    }

    const binding = await queries.communityBot.getBotBinding(db, row.agentId)
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
