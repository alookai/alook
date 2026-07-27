import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { CACHE_IMMUTABLE } from "@alook/shared"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { bindCacheKV } from "@/lib/cache"
import { resolveBotActor } from "@/lib/middleware/community-agent-runner-auth"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"
import { isChannelTarget, isThreadTarget, isDmTarget } from "@/lib/community/message-handler"

// Reject any segment that could smuggle traversal or escape the bucket.
function isSafeSegment(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\")
}

/**
 * Authenticated media proxy for community attachments.
 *
 * Catch-all `[...key]` requires a custom params shape (`string[]`) that
 * `withAuth`/`withCommunityActor`'s `Record<string, string>` typing rejects,
 * so we resolve the caller here instead of going through that middleware.
 * Both a `crk_` runner key (bot) and a Better-Auth session (human) resolve to
 * a `userId` used for the membership/participation gate below.
 */
export const GET = async (
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) => {
  const { key } = await params
  if (!key?.length) return writeError("not found", 404)
  if (!key.every(isSafeSegment)) return writeError("invalid path", 400)

  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as Env
  bindCacheKV(cloudflareEnv.CACHE_KV ?? null)

  const db = getDb(cloudflareEnv.DB)

  // A `crk_` bearer resolves to the bot's own user id (same 3-lookup chain the
  // community routes use); anything else falls back to the Better-Auth session.
  let userId: string
  const botResolution = await resolveBotActor(db, req.headers.get("Authorization"))
  if (botResolution.kind === "error") return botResolution.response
  if (botResolution.kind === "bot") {
    userId = botResolution.actor.botUserId
  } else {
    const auth = createAuth(cloudflareEnv)
    let session: Awaited<ReturnType<typeof auth.api.getSession>>
    try {
      session = await auth.api.getSession({ headers: req.headers })
    } catch {
      return writeError("session validation failed", 503)
    }
    if (!session) return writeError("unauthorized", 401)
    userId = session.user.id
  }

  const [kind, id] = key

  // Authorize by resource kind. Each branch loads the parent resource and
  // verifies membership/participation BEFORE serving any bytes.
  if (isChannelTarget(kind) || isThreadTarget(kind)) {
    if (!id) return writeError("not found", 404)
    const check = await requireChannelMember(db, id, userId)
    if (!check.ok) return writeError(check.error, check.status)
  } else if (isDmTarget(kind)) {
    if (!id) return writeError("not found", 404)
    // Block check is inherited from `requireDMParticipant` — do not re-inline.
    const check = await requireDMParticipant(db, id, userId)
    if (!check.ok) return writeError(check.error, check.status)
  } else if (kind === "server-icon") {
    // Icons are readable by any authenticated user — auth-only gate.
  } else {
    return writeError("not found", 404)
  }

  const r2Key = key.join("/")
  const obj = await cloudflareEnv.COMMUNITY_MEDIA.get(r2Key)
  if (!obj) return writeError("not found", 404)

  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream"
  const isImage = contentType.startsWith("image/")
  const lastSegment = key[key.length - 1] ?? "file"

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": isImage ? "inline" : `attachment; filename="${lastSegment}"`,
      "Cache-Control": CACHE_IMMUTABLE,
    },
  })
}
