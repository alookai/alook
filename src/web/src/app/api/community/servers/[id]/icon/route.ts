import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { withPrivateMediaCache } from "@/lib/middleware/private-media-cache"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS, createLogger } from "@alook/shared"
import { requireServerAdmin } from "@/lib/community/permissions"
import { handleServerIconUpload } from "@/lib/community/upload"
import { ATTACHMENT_PRIVATE_IMMUTABLE_CACHE, isOwnedServerIconKey, serverIconUrl } from "@/lib/community/storage"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import {
  communityMediaCleanupErrorCategory,
  deleteCommunityMediaObjects,
  scheduleCommunityMediaCleanup,
} from "@/lib/community/community-media-cleanup"

const log = createLogger({ service: "community-server-icon" })

export const GET = withPrivateMediaCache(withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const server = await queries.communityServer.getServer(db, serverId)
  if (!server?.icon) return writeError("no icon", 404)

  if (req.nextUrl.searchParams.get("v") !== server.icon) {
    return new Response(null, {
      status: 307,
      headers: { Location: serverIconUrl(server)!, "Cache-Control": "private, no-store" },
    })
  }

  const obj = await ctx.env.COMMUNITY_MEDIA.get(server.icon)
  if (!obj) return writeError("not found", 404)

  const headers = new Headers({
    "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
    "Cache-Control": ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
  })
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag)
  if (obj.httpEtag && req.headers.get("If-None-Match") === obj.httpEtag) {
    return new Response(null, { status: 304, headers })
  }

  return new Response(obj.body, {
    headers,
  })
}))

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // This pre-upload value is the CAS expectation and the only old object a
  // successful winner may later clean.
  const previousKey = (await queries.communityServer.getServer(db, serverId))?.icon ?? null

  let executionContext: ExecutionContext
  try {
    ({ ctx: executionContext } = await getCloudflareContext({ async: true }))
  } catch {
    return writeError("internal error", 500)
  }

  const result = await handleServerIconUpload(req, ctx.env, serverId)
  if (!result.ok) return result.response

  const iconKey = result.key
  let updated
  try {
    updated = await queries.communityServer.updateServerIconIfCurrent(db, {
      serverId,
      expectedIcon: previousKey,
      nextIcon: iconKey,
    })
  } catch (error) {
    let live
    try {
      live = await queries.communityServer.getServer(db, serverId)
    } catch (verificationError) {
      log.warn("community_server_icon_cas_state_verification_failed", {
        serverId,
        phase: "cas_error_verification",
        objectState: "retained_unverified",
        errorCategory: communityMediaCleanupErrorCategory(verificationError),
      })
      throw error
    }
    if (live?.icon !== iconKey) {
      await compensateServerIcon(ctx.env.COMMUNITY_MEDIA, serverId, iconKey)
    }
    throw error
  }

  if (!updated) {
    let live
    try {
      live = await queries.communityServer.getServer(db, serverId)
    } catch (error) {
      log.warn("community_server_icon_cas_state_verification_failed", {
        serverId,
        phase: "cas_zero_verification",
        objectState: "retained_unverified",
        errorCategory: communityMediaCleanupErrorCategory(error),
      })
      return writeError("internal error", 500)
    }
    if (live?.icon !== iconKey) {
      await compensateServerIcon(ctx.env.COMMUNITY_MEDIA, serverId, iconKey)
    }
    if (!live) return writeError("server not found", 404)
    return writeError("server icon changed; retry", 409)
  }

  if (previousKey && previousKey !== iconKey && isOwnedServerIconKey(previousKey, serverId)) {
    scheduleCommunityMediaCleanup(ctx.env.COMMUNITY_MEDIA, executionContext, {
      keys: [previousKey],
      warning: {
        event: "community_server_icon_cleanup_failed",
        fields: { serverId, phase: "old_key_cleanup" },
      },
    })
  }

  const url = serverIconUrl({ id: serverId, icon: iconKey })!
  void fanOutToServerMembers(serverId, {
    type: WS_EVENTS.SERVER_UPDATE,
    serverId,
    changes: { icon: url },
  })
  return writeJSON({ url })
})

async function compensateServerIcon(
  bucket: Pick<R2Bucket, "delete">,
  serverId: string,
  iconKey: string,
): Promise<void> {
  try {
    await deleteCommunityMediaObjects(bucket, [iconKey])
  } catch (error) {
    log.warn("community_server_icon_cleanup_failed", {
      serverId,
      phase: "cas_compensation",
      keyCount: 1,
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
  }
}
