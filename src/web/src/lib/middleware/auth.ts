import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { cached, cacheKeys, bindCacheKV } from "@/lib/cache"

export interface AuthContext {
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
          cached(
            cacheKeys.machineTokenLastUsed(raw),
            900,
            async () => {
              await queries.machineToken.updateMachineTokenLastUsed(db, mt.id);
              return "1";
            },
          ).catch(() => {});
          const authCtx: AuthContext = {
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

    // Fall back to Better Auth session
    const auth = createAuth(cloudflareEnv)
    let session: Awaited<ReturnType<typeof auth.api.getSession>> = null
    let lastErr: unknown

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        session = await auth.api.getSession({ headers: req.headers })
        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
      }
    }

    if (lastErr) {
      return NextResponse.json({ error: "session validation failed" }, { status: 503 })
    }
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const authCtx: AuthContext = {
      userId: session.user.id,
      email: session.user.email,
    }
    return handler(req, { ...authCtx, params: resolvedParams })
  }
}
