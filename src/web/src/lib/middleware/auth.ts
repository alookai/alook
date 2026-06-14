import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { cached, cacheKeys, bindCacheKV, throttled } from "@/lib/cache"

export interface AuthContext {
  env: Env
  userId: string
  email: string
  workspaceId?: string
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
          const mt = await cached(
            cacheKeys.machineToken(raw),
            900,
            () => queries.machineToken.getMachineTokenByToken(db, raw),
          )
          if (!mt) {
            return NextResponse.json({ error: "invalid token" }, { status: 401 })
          }
          throttled(
            cacheKeys.machineTokenLastUsed(raw),
            900,
            () => queries.machineToken.updateMachineTokenLastUsed(db, mt.id),
          ).catch(() => {});
          const authCtx: AuthContext = {
            env: cloudflareEnv,
            userId: mt.userId,
            email: mt.userEmail,
            workspaceId: mt.workspaceId ?? undefined,
          }
          return handler(req, { ...authCtx, params: resolvedParams })
        } catch {
          return NextResponse.json({ error: "invalid token" }, { status: 401 })
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
