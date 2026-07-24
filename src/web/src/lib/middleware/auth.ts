import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { getKV, cacheKeys, bindCacheKV } from "@/lib/cache"

export interface AuthContext {
  env: Env
  userId: string
  email: string
  workspaceId?: string
}

/**
 * Merged machine-token cache entry. One KV read per authenticated request
 * yields BOTH the token-validation result (`row`) and the last-used bump
 * throttle (`luAt`, the epoch ms of the last `last_used_at` D1 write),
 * replacing the old two-key `mt:` + `mt_lu:` pair.
 *
 * `row: null` is a NEGATIVE cache — an invalid token is remembered so a
 * repeated bad token doesn't re-hit D1 every request. A token string only
 * exists after `createMachineToken` commits, and revoke/delete paths
 * `invalidate(cacheKeys.machineToken(token))`. The one null→non-null window
 * is read-replica lag on a freshly-created token, so negative entries use a
 * short `MT_NEG_TTL_S` to bound any false-401 lockout.
 */
type MachineTokenRow = Awaited<ReturnType<typeof queries.machineToken.getMachineTokenByToken>>
interface MachineTokenEntry {
  row: MachineTokenRow
  luAt: number
}
const MT_TTL_S = 900
// Negative (`row: null`) entries live only briefly. D1 reads go through
// read-replica sessions (`first-unconstrained`), so a freshly-created token
// can momentarily read null due to replication lag; a full 15-min negative
// TTL would then 401 a valid token for the whole window. 60s (KV's floor)
// still absorbs repeated-bad-token storms without a long lockout.
const MT_NEG_TTL_S = 60
const MT_BUMP_INTERVAL_MS = 900_000

/**
 * Warm the positive machine-token cache entry with a known-good row. Called at
 * activation time so the daemon's first poll — a separate Worker invocation
 * that may read a lagged replica (D1 uses `first-unconstrained` sessions) —
 * hits a positive KV entry instead of reading `null` and negative-caching a
 * 401 for `MT_NEG_TTL_S`. Best-effort (a KV blip just means the next poll does
 * a cold read); no-op without KV. This is the ONLY other writer of the `mt:`
 * entry, so it lives beside the reader to keep the `{ row, luAt }` shape and
 * `MT_TTL_S` in one place.
 */
export async function warmMachineTokenCache(
  kv: KVNamespace | null,
  token: string,
  row: NonNullable<MachineTokenRow>,
): Promise<void> {
  if (!kv) return
  const entry: MachineTokenEntry = { row, luAt: Date.now() }
  await kv
    .put(cacheKeys.machineToken(token), JSON.stringify(entry), { expirationTtl: MT_TTL_S })
    .catch(() => {})
}

export type AuthenticatedHandler = (
  req: NextRequest,
  ctx: AuthContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

export function withAuth(handler: AuthenticatedHandler) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> | Record<string, string> }
  ) => {
    const resolvedParams = context?.params
      ? context.params instanceof Promise
        ? await context.params
        : context.params
      : undefined

    const { env } = await getCloudflareContext({ async: true })
    const cloudflareEnv = env as Env
    bindCacheKV(cloudflareEnv.CACHE_KV ?? null)

    const authHeader = req.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer ")) {
      const raw = authHeader.slice(7)
      if (raw.startsWith("al_")) {
        try {
          const db = getDb(cloudflareEnv.DB)
          const kv = getKV()
          const key = cacheKeys.machineToken(raw)
          const now = Date.now()

          // Read the merged entry. A KV blip must NOT turn a valid token into
          // a 401 — on read failure we fall through to D1 (mirrors `cached`).
          let entry: MachineTokenEntry | null = null
          if (kv) {
            try {
              const cachedRaw = await kv.get(key)
              if (cachedRaw) {
                const parsed = JSON.parse(cachedRaw) as Partial<MachineTokenEntry>
                // Shape guard: a pre-upgrade deploy stored the bare row under
                // this same `mt:` key (old `cached()` format). Reading that as
                // a MachineTokenEntry would leave `row` undefined → a false 401
                // for a VALID token until the old entry's TTL expires (and the
                // daemon treats sustained 401s as a dead token). Only accept the
                // new `{ row, luAt }` shape; anything else falls through to a
                // cold D1 miss that repopulates in the new format.
                if (parsed && "row" in parsed && typeof parsed.luAt === "number") {
                  entry = parsed as MachineTokenEntry
                }
              }
            } catch {
              entry = null
            }
          }

          let bump = false
          if (!entry) {
            // Cold miss: hit D1 and populate. On a hit, bump immediately so
            // `last_used_at` reflects first contact (preserves prior
            // semantics), then remember it for the TTL window.
            const row = await queries.machineToken.getMachineTokenByToken(db, raw)
            entry = { row, luAt: now }
            bump = row != null
            if (kv) {
              const ttl = row != null ? MT_TTL_S : MT_NEG_TTL_S
              kv.put(key, JSON.stringify(entry), { expirationTtl: ttl }).catch(() => {})
            }
          } else if (entry.row && now - entry.luAt > MT_BUMP_INTERVAL_MS) {
            // Warm hit, throttle window elapsed: bump and refresh luAt.
            bump = true
            if (kv) {
              kv.put(key, JSON.stringify({ row: entry.row, luAt: now }), { expirationTtl: MT_TTL_S }).catch(() => {})
            }
          }

          const mt = entry.row
          if (!mt) {
            // row === null is the ONLY "definitely invalid" signal (token
            // doesn't exist). The daemon uses this 401 to mark a workspace
            // as auth-failed, so it must never fire on transient infra
            // failure — those throw and fall to the 503 catch below.
            return NextResponse.json({ error: "invalid token" }, { status: 401 })
          }
          if (bump) {
            Promise.resolve(queries.machineToken.updateMachineTokenLastUsed(db, mt.id)).catch(() => {})
          }
          const authCtx: AuthContext = {
            env: cloudflareEnv,
            userId: mt.userId,
            email: mt.userEmail,
            workspaceId: mt.workspaceId ?? undefined,
          }
          return handler(req, { ...authCtx, params: resolvedParams })
        } catch {
          // D1 query / getDb / getKV threw — transient infra failure, NOT an
          // invalid token. Mirror the session path's 503 so the daemon retries
          // instead of treating a DB blip as a revoked token (which would
          // wrongly mark the workspace deleted).
          return NextResponse.json({ error: "auth temporarily unavailable" }, { status: 503 })
        }
      }
    }

    // Fall back to Better Auth session (with returnHeaders to propagate cookie cache refresh)
    const auth = createAuth(cloudflareEnv)
    let sessionResult: { headers: Headers; response: Awaited<ReturnType<typeof auth.api.getSession>> } | null = null
    let lastErr: unknown

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        sessionResult = await auth.api.getSession({
          headers: req.headers,
          returnHeaders: true,
        }) as { headers: Headers; response: Awaited<ReturnType<typeof auth.api.getSession>> }
        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
      }
    }

    if (lastErr) {
      return NextResponse.json({ error: "session validation failed" }, { status: 503 })
    }
    if (!sessionResult?.response) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    // Session guard — Better-Auth's Drizzle adapter reads user rows via
    // .select() directly, so a session cookie may carry stale state after a
    // user is soft-deleted or if some future flow ever mints a session for a
    // bot user row. Enforce at request-time:
    //   - deletedAt != null → session invalid
    //   - isBot === true    → session invalid (bots must never sign in)
    // Belt-and-braces with the databaseHooks.session.create.before hook.
    try {
      const db = getDb(cloudflareEnv.DB)
      const internal = await queries.user.getUserInternal(
        db,
        sessionResult.response.user.id,
      )
      if (!internal || internal.deletedAt !== null || internal.isBot === true) {
        // Best-effort server-side invalidation. Cookie clear happens via the
        // 401 response below; Better-Auth will see the missing session next
        // request.
        try {
          await auth.api.signOut({ headers: req.headers })
        } catch {
          // ignore — signOut best-effort
        }
        const invalid = NextResponse.json(
          { error: "session no longer valid" },
          { status: 401 },
        )
        // Clear known Better-Auth cookie names to prevent replay.
        invalid.cookies.set("better-auth.session_token", "", { maxAge: 0, path: "/" })
        invalid.cookies.set("better-auth.session_data", "", { maxAge: 0, path: "/" })
        return invalid
      }
    } catch {
      // Fall through — if the guard read fails, session validation already
      // succeeded and we don't want to break auth for an incidental read error.
    }

    const authCtx: AuthContext = {
      env: cloudflareEnv,
      userId: sessionResult.response.user.id,
      email: sessionResult.response.user.email,
    }
    const res = await handler(req, { ...authCtx, params: resolvedParams })

    // Forward Set-Cookie headers from Better Auth to refresh session_data cookie cache
    const setCookies = sessionResult.headers.getSetCookie()
    if (setCookies.length > 0) {
      const mutableRes = new NextResponse(res.body, res)
      for (const cookie of setCookies) {
        mutableRes.headers.append("Set-Cookie", cookie)
      }
      return mutableRes
    }

    return res
  }
}
