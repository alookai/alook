import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

interface CommunityPairingTokenContext {
  env: Env
  rawTokenId: string
}

export type CommunityPairingTokenAuthenticatedHandler = (
  req: NextRequest,
  ctx: CommunityPairingTokenContext & { params?: Record<string, string> }
) => Promise<NextResponse | Response>

/**
 * Community pairing-token middleware. Requires `Authorization: Bearer cmt_…`;
 * parses and validates the `cmt_` prefix but does NOT resolve or consume the
 * token — the caller (currently `daemon/activate`) needs the raw `tokenId`
 * for its atomic exchange in the DB.
 *
 * Rejects with 401 on missing header, non-Bearer prefix, or wrong token
 * prefix. Response body is `{ error: string }`, matching the wire contract
 * used by the sibling `withCommunityDaemonAuth` middleware.
 */
export function withCommunityPairingToken(handler: CommunityPairingTokenAuthenticatedHandler) {
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
      return NextResponse.json({ error: "missing Authorization header" }, { status: 401 })
    }
    const rawTokenId = authHeader.slice(7).trim()
    if (!rawTokenId.startsWith("cmt_")) {
      return NextResponse.json({ error: "invalid pairing token" }, { status: 401 })
    }

    const { env } = await getCloudflareContext({ async: true })
    const cloudflareEnv = env as Env

    return handler(req, {
      env: cloudflareEnv,
      rawTokenId,
      params: resolvedParams,
    })
  }
}
