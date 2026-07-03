import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, CACHE_SHORT, createLogger } from "@alook/shared"
import { requireServerAdmin } from "@/lib/community/permissions"
import { handleServerIconUpload } from "@/lib/community/upload"
import { serverIconUrl } from "@/lib/community/storage"

const log = createLogger({ service: "community-server-icon" })

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const server = await queries.communityServer.getServer(db, serverId)
  if (!server?.icon) return writeError("no icon", 404)

  const obj = await ctx.env.COMMUNITY_MEDIA.get(server.icon)
  if (!obj) return writeError("not found", 404)

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": CACHE_SHORT,
    },
  })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Snapshot the previous key BEFORE upload so we can sweep it after the
  // update commits. The `startsWith` guard on cleanup skips legacy URL-shaped
  // rows that predate the migration.
  const previousKey = (await queries.communityServer.getServer(db, serverId))?.icon ?? null

  const result = await handleServerIconUpload(req, ctx.env, serverId)
  if (!result.ok) return result.response

  const iconKey = result.key
  const updated = await queries.communityServer.updateServer(db, serverId, { icon: iconKey })
  if (!updated) return writeError("server not found", 404)

  if (previousKey && previousKey !== iconKey && previousKey.startsWith("server-icon/")) {
    // Wrap in waitUntil so the CF runtime explicitly extends the worker
    // lifetime past the response for the R2 delete to complete.
    const deletePromise = ctx.env.COMMUNITY_MEDIA.delete(previousKey).catch((err) =>
      log.warn("server_icon_delete_failed", { err, serverId, previousKey }),
    )
    try {
      const { ctx: cfCtx } = await getCloudflareContext({ async: true })
      cfCtx.waitUntil(deletePromise)
    } catch {
      // Not in a CF context (tests / non-worker runtime) — the promise still
      // runs on its own; the fire-and-forget behaviour matches the prior code.
    }
  }

  return writeJSON({ url: serverIconUrl({ id: serverId, icon: iconKey }) })
})
