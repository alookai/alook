import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDb } from "@/lib/db"
import { resolveBotActor } from "./community-agent-runner-auth"
import { withAuth, type AuthContext } from "./auth"

/**
 * The unified community actor — a human OR a bot resolved to one shape.
 * Community REST routes read `ctx.userId` without caring which they got;
 * the few points that need owner semantics (e.g. invite owner-gate) read
 * `ownerUserId`, and the few that must branch (e.g. member-list bot gating)
 * read `isBot`.
 *
 * Field mapping for the bot path: `userId === botUserId` (a bot IS a user
 * row — the "bots are users" invariant). `ownerUserId`/`machineId` are only
 * present on the bot path; a human actor has neither.
 */
interface CommunityActorContext {
  env: Env
  userId: string
  isBot: boolean
  ownerUserId?: string
  machineId?: string
  /** The human `email`, only on the human path (bots have no meaningful email surface here). */
  email?: string
}

export type CommunityActorHandler = (
  req: NextRequest,
  ctx: CommunityActorContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

/**
 * Community auth middleware that resolves BOTH a `crk_` runner key (bot) and
 * a session/`al_` credential (human) into a single `CommunityActorContext`.
 *
 * - **bot path**: `Authorization: Bearer crk_…` → `resolveBotActor` (the same
 *   3-lookup chain + 401/503 semantics `withAgentRunnerAuth` uses). Sets
 *   `isBot: true`, `userId = botUserId`, plus `ownerUserId`/`machineId`.
 * - **human path**: anything else → delegated to `withAuth` verbatim, so the
 *   machine-token KV cache, session guard (incl. the isBot-session rejection),
 *   and Set-Cookie refresh all behave exactly as on non-community routes. The
 *   human `AuthContext` is adapted to `CommunityActorContext` with `isBot`
 *   derived from `withAuth`'s own session guard (`ctx.user?.isBot`, always
 *   false in practice since a bot session is rejected at 401).
 *
 * Design note: the human path DELEGATES to `withAuth` rather than duplicating
 * its resolve logic — this keeps `auth.ts` untouched (its semantics unchanged)
 * while reusing every hardening path it already has. `withAuth` only runs when
 * the request is NOT a `crk_` bearer, so a bot request never pays the
 * session/KV cost and a human request never touches the runner-key lookups.
 */
export function withCommunityActor(handler: CommunityActorHandler) {
  const delegatedHuman = withAuth(async (req, humanCtx: AuthContext & { params?: Record<string, string> }) => {
    const actorCtx: CommunityActorContext & { params?: Record<string, string> } = {
      env: humanCtx.env,
      userId: humanCtx.userId,
      isBot: humanCtx.user?.isBot === true,
      email: humanCtx.email,
      params: humanCtx.params,
    }
    return handler(req, actorCtx)
  })

  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> | Record<string, string> }
  ) => {
    const authHeader = req.headers.get("Authorization")

    // Bot path only when it's actually a crk_ bearer — otherwise fall straight
    // through to the human delegate (which does its own header parsing).
    if (authHeader?.startsWith("Bearer ") && authHeader.slice(7).trim().startsWith("crk_")) {
      const resolvedParams = context?.params
        ? context.params instanceof Promise
          ? await context.params
          : context.params
        : undefined

      const { env } = await getCloudflareContext({ async: true })
      const cloudflareEnv = env as Env
      const db = getDb(cloudflareEnv.DB)

      const resolved = await resolveBotActor(db, authHeader)
      if (resolved.kind === "error") return resolved.response
      if (resolved.kind === "bot") {
        return handler(req, {
          env: cloudflareEnv,
          userId: resolved.actor.botUserId,
          isBot: true,
          ownerUserId: resolved.actor.ownerUserId,
          machineId: resolved.actor.machineId,
          params: resolvedParams,
        })
      }
      // `not_bot` despite a crk_ prefix (empty/garbage after prefix) —
      // reject rather than silently falling to the human path, so a
      // malformed runner key can't be reinterpreted as a session attempt.
      return NextResponse.json({ error: "invalid runner key" }, { status: 401 })
    }

    return delegatedHuman(req, context)
  }
}
