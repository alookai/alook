import { createAuth, type AuthPolicy, type AuthResolution } from "./auth-policy"
import { observeWorkerOperation } from "@/lib/observability/worker"
import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { COMMUNITY_BOT_ACTOR_HEADER, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { bindCacheKV } from "@/lib/cache"
import { protectCommunityJsonResponse, rejectUnknownCommunityContract, varyPrivateResponseByCredentials } from "./response-cache"

export interface AuthContext {
  env: Env
  userId: string
  email: string
  /**
   * The authenticated user's internal flags. Populated from the request-time
   * session guard. `isBot` is always false in production (a bot session is
   * rejected at 401 before the handler runs), but friend-graph routes assert
   * `ctx.user?.isBot` locally as belt-and-suspenders.
   */
  user?: { isBot: boolean }
}

interface CookieHumanAuthContext extends AuthContext {
  executionContext: ExecutionContext
}

/**
 * Context for a `withOptionalAuth` handler: identical to `AuthContext` but
 * `userId`/`email` are OPTIONAL — absent when the caller is anonymous (no
 * session, an errored session lookup, or a bot/deleted session degraded to
 * anonymous). A distinct interface so `AuthContext.userId` stays required and
 * no existing `withAuth` handler is disturbed.
 *
 * Not exported: handlers infer this shape from `OptionalAuthHandler`, so no
 * caller imports it by name yet. Export it once a handler needs the type
 * standalone (as `AuthContext` is, because withAuth handlers import it).
 */
interface OptionalAuthContext {
  env: Env
  userId?: string
  email?: string
  user?: { isBot: boolean }
}

export type AuthenticatedHandler = (
  req: NextRequest,
  ctx: AuthContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

export type OptionalAuthHandler = (
  req: NextRequest,
  ctx: OptionalAuthContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

export type CookieHumanAuthHandler = (
  req: NextRequest,
  ctx: CookieHumanAuthContext & { params?: Record<string, string> },
) => Promise<NextResponse | Response>

/**
 * Outcome of resolving a Better-Auth cookie session. Shared by `withAuth`
 * (which turns everything but `ok` into a 401/503) and `withOptionalAuth`
 * (which turns everything but `ok` into anonymous). Keeping the resolution in
 * ONE place means the two wrappers can never drift on session semantics — only
 * on what they DO with a non-`ok` outcome.
 *
 * - `ok`        — a valid, non-bot, non-deleted session; `user` is populated.
 * - `error`     — getSession threw on both attempts (transient infra failure).
 * - `none`      — no session cookie / no session.
 * - `invalid`   — a session for a bot or soft-deleted user; `signOut` was
 *                 attempted best-effort and the caller should clear cookies.
 */
type SessionResolution =
  | {
      kind: "ok"
      user: { id: string; email: string; isBot: boolean }
      setCookies: string[]
    }
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "invalid" }

async function resolveSession(
  req: NextRequest,
  cloudflareEnv: Env,
): Promise<SessionResolution> {
  const auth = getAuth(cloudflareEnv)
  let sessionResult: { headers: Headers; response: Awaited<ReturnType<typeof auth.api.getSession>> } | null = null
  let lastErr: unknown

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      sessionResult = await observeWorkerOperation("auth.get_session", {}, () => auth.api.getSession({
        headers: req.headers,
        query: { disableCookieCache: new URL(req.url).pathname.startsWith("/api/community/") },
        returnHeaders: true,
      })) as { headers: Headers; response: Awaited<ReturnType<typeof auth.api.getSession>> }
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
    }
  }

  if (lastErr) return { kind: "error" }
  if (!sessionResult?.response) return { kind: "none" }

  const guardUser = sessionResult.response.user as { isBot?: boolean | null; deletedAt?: string | null }
  const sessionUserIsBot = guardUser.isBot === true
  if (sessionUserIsBot || (guardUser.deletedAt ?? null) !== null) {
    // Best-effort server-side invalidation. The caller clears cookies on its
    // response; Better-Auth will see the missing session next request.
    try {
      await auth.api.signOut({ headers: req.headers })
    } catch {
      // ignore — signOut best-effort
    }
    return { kind: "invalid" }
  }

  return {
    kind: "ok",
    user: {
      id: sessionResult.response.user.id,
      email: sessionResult.response.user.email,
      isBot: sessionUserIsBot,
    },
    setCookies: sessionResult.headers.getSetCookie(),
  }
}

// Clear known Better-Auth cookie names on a response to prevent replay of a
// session that the request-time guard rejected.
function clearAuthCookies(res: NextResponse): void {
  res.cookies.set("better-auth.session_token", "", { maxAge: 0, path: "/" })
  res.cookies.set("better-auth.session_data", "", { maxAge: 0, path: "/" })
}

function clearCookieHumanAuthCookies(res: NextResponse): void {
  clearAuthCookies(res)
  res.cookies.set("__Secure-better-auth.session_token", "", {
    maxAge: 0,
    path: "/",
    secure: true,
  })
  res.cookies.set("__Secure-better-auth.session_data", "", {
    maxAge: 0,
    path: "/",
    secure: true,
  })
}

function forwardSetCookies(res: NextResponse | Response, setCookies: string[]): NextResponse | Response {
  if (setCookies.length === 0) return res
  const cookieName = (cookie: string) => cookie.split("=", 1)[0].trim().toLowerCase()
  const responseCookieNames = new Set(res.headers.getSetCookie().map(cookieName))
  const forwarded = setCookies.filter((cookie) => !responseCookieNames.has(cookieName(cookie)))
  if (forwarded.length === 0) return res
  const mutableRes = new NextResponse(res.body, res)
  for (const cookie of forwarded) mutableRes.headers.append("Set-Cookie", cookie)
  return mutableRes
}

function accountDeletionAuthError(error: string, status: number): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  )
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
}

function isCookieHumanSameOrigin(req: NextRequest): boolean {
  const originHeader = req.headers.get("Origin")
  if (!originHeader) return false
  let originUrl: URL
  try {
    originUrl = new URL(originHeader)
  } catch {
    return false
  }
  if (originHeader !== originUrl.origin) return false
  const requestUrl = new URL(req.url)
  if (originUrl.origin === requestUrl.origin) return true
  return isLoopbackHostname(originUrl.hostname)
    && isLoopbackHostname(requestUrl.hostname)
    && req.headers.get("Host") === originUrl.host
}

function rejectBotSelection(req: NextRequest): NextResponse | null {
  return req.headers.has(COMMUNITY_BOT_ACTOR_HEADER)
    ? NextResponse.json({ error: "bot selection is not supported by this endpoint" }, { status: 403 })
    : null
}

async function resolveCookieHuman(req: NextRequest): Promise<AuthResolution<CookieHumanAuthContext>> {
  if (req.method !== "POST" || !isCookieHumanSameOrigin(req)) {
    return accountDeletionAuthError("FORBIDDEN", 403)
  }
  if (req.headers.has("Authorization")) {
    return accountDeletionAuthError("UNAUTHORIZED", 401)
  }
  const unsupported = rejectUnknownCommunityContract(req)
  if (unsupported) return unsupported

  const cloudflare = await getCloudflareContext({ async: true })
  const cloudflareEnv = cloudflare.env as Env
  bindCacheKV(cloudflareEnv.CACHE_KV ?? null)
  const resolved = await resolveSession(req, cloudflareEnv)
  if (resolved.kind === "error") {
    return accountDeletionAuthError("SESSION_VALIDATION_FAILED", 503)
  }
  if (resolved.kind === "none") {
    return accountDeletionAuthError("UNAUTHORIZED", 401)
  }
  if (resolved.kind === "invalid") {
    const response = accountDeletionAuthError("UNAUTHORIZED", 401)
    clearCookieHumanAuthCookies(response)
    return response
  }

  let liveUser: Awaited<ReturnType<typeof queries.user.getUserInternal>>
  try {
    liveUser = await queries.user.getUserInternal(
      getPrimaryDb(cloudflareEnv.DB),
      resolved.user.id,
    )
  } catch {
    return accountDeletionAuthError("SESSION_VALIDATION_FAILED", 503)
  }
  if (!liveUser || liveUser.isBot || liveUser.deletedAt !== null) {
    const response = accountDeletionAuthError("UNAUTHORIZED", 401)
    clearCookieHumanAuthCookies(response)
    return response
  }

  return {
    context: {
      env: cloudflareEnv,
      executionContext: cloudflare.ctx,
      userId: liveUser.id,
      email: liveUser.email,
      user: { isBot: false },
    },
    finish: response => forwardSetCookies(response, resolved.setCookies),
  }
}

export async function resolveHumanAuth(req: NextRequest): Promise<AuthResolution<AuthContext>> {
  if (req.headers.get("Authorization")?.startsWith("Bearer al_")) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 })
  }
  const unsupported = rejectUnknownCommunityContract(req)
  if (unsupported) return unsupported
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as Env
  bindCacheKV(cloudflareEnv.CACHE_KV ?? null)
  const session = await resolveSession(req, cloudflareEnv)

  if (session.kind === "error") {
    return NextResponse.json({ error: "session validation failed" }, { status: 503 })
  }
  if (session.kind === "none") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  if (session.kind === "invalid") {
    const invalid = NextResponse.json(
      { error: "session no longer valid" },
      { status: 401 },
    )
    clearAuthCookies(invalid)
    return invalid
  }

  const authCtx: AuthContext = {
    env: cloudflareEnv,
    userId: session.user.id,
    email: session.user.email,
    user: { isBot: session.user.isBot },
  }
  return {
    context: authCtx,
    finish: response => varyPrivateResponseByCredentials(forwardSetCookies(response, session.setCookies)),
  }
}

export const humanAuthPolicy: AuthPolicy<AuthContext> = {
  preflight: rejectBotSelection,
  resolve: resolveHumanAuth,
  respond: protectCommunityJsonResponse,
}

export const cookieHumanAuthPolicy: AuthPolicy<CookieHumanAuthContext> = {
  preflight: rejectBotSelection,
  resolve: resolveCookieHuman,
  respond: protectCommunityJsonResponse,
}

export const withCookieHumanAuth = createAuth(cookieHumanAuthPolicy)

export const withAuth = createAuth(humanAuthPolicy)

/**
 * Session-optional wrapper for pages that render the SAME content whether or
 * not the visitor is logged in (e.g. the invite landing page). Unlike
 * `withAuth`, it NEVER 401s on a missing session — the handler always runs.
 *
 * Red lines (Cecilia, /Gus/working #1131 #1 / #1147):
 * 1. Single-purpose: resolves the Better-Auth cookie session ONLY.
 * 2. Never 401 for auth reasons. Missing session → anonymous. A bot/deleted
 *    session degrades to anonymous (cookies cleared best-effort) rather than
 *    blocking. A transient getSession failure also degrades to anonymous — the
 *    page is public-readable, so failing open is correct here.
 * 3. It only answers "who are you (or anonymous)". What data a route exposes is
 *    the route's decision; this wrapper carries no disclosure logic, so it is
 *    reusable by any future login-optional page.
 */
export const optionalAuthPolicy: AuthPolicy<OptionalAuthContext> = {
  preflight: req => rejectUnknownCommunityContract(req) ?? rejectBotSelection(req),
  resolve: resolveOptionalHuman,
  respond: protectCommunityJsonResponse,
}

export const withOptionalAuth = createAuth(optionalAuthPolicy)

async function resolveOptionalHuman(req: NextRequest): Promise<AuthResolution<OptionalAuthContext>> {
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as Env
  bindCacheKV(cloudflareEnv.CACHE_KV ?? null)

  const session = await resolveSession(req, cloudflareEnv)

  if (session.kind !== "ok") {
    return {
      context: { env: cloudflareEnv },
      finish: session.kind === "invalid" ? response => {
        const mutableRes = new NextResponse(response.body, response)
        clearAuthCookies(mutableRes)
        return mutableRes
      } : undefined,
    }
  }
  return {
    context: {
      env: cloudflareEnv,
      userId: session.user.id,
      email: session.user.email,
      user: { isBot: session.user.isBot },
    },
    finish: response => forwardSetCookies(response, session.setCookies),
  }
}
