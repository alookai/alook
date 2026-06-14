import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

interface EnvContext {
  env: Env
  params?: Record<string, string | string[]>
}

export type EnvHandler = (
  req: NextRequest,
  ctx: EnvContext
) => Promise<NextResponse | Response>

export function withEnv(handler: EnvHandler) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
  ) => {
    const resolvedParams = context?.params
      ? context.params instanceof Promise
        ? await context.params
        : context.params
      : undefined

    const { env } = await getCloudflareContext({ async: true })

    return handler(req, { env: env as Env, params: resolvedParams })
  }
}
