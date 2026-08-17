import { NextRequest } from "next/server"
import { CACHE_REVALIDATE } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { buildUserAvatarKey } from "@/lib/community/storage"

// Any authenticated user can fetch — mirrors the server-icon serve route's
// "readable by any authenticated user" gate. Message authors, member lists,
// DM peers, etc. all need to render this avatar without an ownership check.
//
// The URL never changes across re-uploads (deterministic key). Let the browser
// paint stale bytes while it revalidates the R2 ETag in the background, so a
// warm avatar never waits behind a network round trip.
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const userId = ctx.params?.userId
  if (!userId) return writeError("missing user id", 400)

  const obj = await ctx.env.COMMUNITY_MEDIA.get(buildUserAvatarKey(userId))
  if (!obj) return writeError("not found", 404)

  const etag = obj.httpEtag
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_REVALIDATE } })
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": CACHE_REVALIDATE,
      ...(etag ? { ETag: etag } : {}),
    },
  })
})
