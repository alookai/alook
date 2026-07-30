import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDb } from "@/lib/db"
import { withAuth, type AuthContext } from "./auth"
import { resolveBotActor } from "./community-agent-runner-auth"

/**
 * The unified community actor — the single identity a `/api/community/*` route
 * handler runs as, whether the caller is a signed-in human (Better-Auth session
 * or `al_` machine token) or a bot (a `crk_` runner key). It fuses the two
 * pre-existing wrappers (`withAuth` for humans, `withAgentRunnerAuth` for bots)
 * behind one decorator so a route can serve both callers and branch on
 * `actor.kind` for the few genuinely bot-specific semantics (channel-alignment
 * gate on send, invite owner-gate on join) — see
 * plans/22-community-unified-actor-route-unify.md.
 *
 * Discriminated on `kind` (NOT a flat `isBot` boolean): the semantic branches
 * read `actor.kind === "bot"` and, in that arm, `ownerUserId`/`machineId` are
 * present without a non-null assertion. `userId` is common to both arms — for a
 * bot it IS the bot's own user id ("bots are users"), so an unbranched handler
 * that only reads `actor.userId` works identically for either caller.
 */
export type CommunityActor =
  | {
      kind: "human"
      userId: string
      email: string
      /** Present on the `al_`/session human path; absent for a bot. */
      workspaceId?: string
    }
  | {
      kind: "bot"
      /** The bot's OWN user id (`= botUserId`). */
      userId: string
      /** The bot's OWNER (the human who minted the runner key). */
      ownerUserId: string
      machineId: string
    }

export interface CommunityActorContext {
  env: Env
  actor: CommunityActor
  params?: Record<string, string>
}

export type CommunityActorHandler = (
  req: NextRequest,
  ctx: CommunityActorContext,
) => Promise<NextResponse | Response>

/**
 * Wrap a `/api/community/*` route handler with unified actor resolution.
 *
 * Auth routing (by the `Authorization` header):
 *   - `Bearer crk_…` → bot path: resolve via the shared `resolveBotActor`.
 *     A `crk_` bearer that FAILS to resolve returns its 401/503 and NEVER
 *     falls through to the human path (a malformed bot token must not be
 *     retried as an anonymous human — that would leak the human 401 shape and
 *     mask a revoked key).
 *   - anything else → human path: delegated VERBATIM to `withAuth`, reusing its
 *     machine-token KV cache, Better-Auth session guard (bot-session rejection,
 *     soft-delete check), and Set-Cookie refresh untouched. The human
 *     `AuthContext` is adapted into `{ kind: "human", … }`.
 *
 * A bot request never pays the session-validation cost; a human never hits the
 * runner-key lookups.
 */
export function withCommunityActor(handler: CommunityActorHandler) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> | Record<string, string> },
  ): Promise<NextResponse | Response> => {
    const resolvedParams = context?.params
      ? context.params instanceof Promise
        ? await context.params
        : context.params
      : undefined

    const authHeader = req.headers.get("Authorization")

    // Bot path — only when a crk_ bearer is actually present. `resolveBotActor`
    // returns `not_bot` for any other header (including an `al_` machine token
    // or a session cookie), which we route to the human `withAuth` path below.
    if (authHeader?.startsWith("Bearer ") && authHeader.slice(7).trim().startsWith("crk_")) {
      const { env } = await getCloudflareContext({ async: true })
      const cloudflareEnv = env as Env
      const db = getDb(cloudflareEnv.DB)

      const resolved = await resolveBotActor(db, authHeader)
      if (resolved.kind === "error") return resolved.response
      // A crk_ bearer that resolves to `not_bot` is unreachable (the guard above
      // guarantees the crk_ prefix), but treat it as an auth failure rather than
      // silently falling through to the human path.
      if (resolved.kind === "not_bot") {
        return NextResponse.json({ error: "invalid runner key" }, { status: 401 })
      }

      return handler(req, {
        env: cloudflareEnv,
        actor: {
          kind: "bot",
          userId: resolved.actor.botUserId,
          ownerUserId: resolved.actor.ownerUserId,
          machineId: resolved.actor.machineId,
        },
        params: resolvedParams,
      })
    }

    // Human path — delegate verbatim to withAuth, adapting its AuthContext into
    // the unified actor. withAuth owns all human auth behavior (KV cache,
    // session guard, Set-Cookie refresh); we do not reimplement any of it.
    const delegated = withAuth(async (r, humanCtx: AuthContext & { params?: Record<string, string> }) => {
      return handler(r, {
        env: humanCtx.env,
        actor: {
          kind: "human",
          userId: humanCtx.userId,
          email: humanCtx.email,
          workspaceId: humanCtx.workspaceId,
        },
        params: humanCtx.params,
      })
    })
    return delegated(req, context)
  }
}

/**
 * Guard for a route (or branch) that a bot must NEVER reach — the privilege-
 * escalation red line (`/bots/*`, `/daemon/*`, human management surfaces) and
 * the human side of a bot-only verb. Returns a 403 `NextResponse` when the
 * actor is a bot, else `null` (proceed). Enforced by the actor's authz, not by
 * "no one calls it".
 */
export function rejectBot(actor: CommunityActor): NextResponse | null {
  if (actor.kind === "bot") {
    return NextResponse.json({ error: "forbidden: not available to bots" }, { status: 403 })
  }
  return null
}

/**
 * Symmetric guard for a bot-only verb (inboxPull/inboxSnapshot/ack/nap, and
 * resolve as a bot op): a human actor → 403 (capability symmetry, Gener #116).
 */
export function requireBot(actor: CommunityActor): NextResponse | null {
  if (actor.kind !== "bot") {
    return NextResponse.json({ error: "forbidden: bot-only endpoint" }, { status: 403 })
  }
  return null
}
