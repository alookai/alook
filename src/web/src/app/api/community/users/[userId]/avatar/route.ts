import { NextRequest } from "next/server"
import { CACHE_REVALIDATE } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { buildUserAvatarKey } from "@/lib/community/storage"

// Any authenticated user can fetch — mirrors the server-icon serve route's
// "readable by any authenticated user" gate. Message authors, member lists,
// DM peers, etc. all need to render this avatar without an ownership check.
//
// The URL never changes across re-uploads (deterministic key), so caching by
// max-age alone would keep every other viewer's browser stuck on the old
// bytes for up to an hour after a replace. Revalidate on every request but
// key it off the R2 ETag so a cache hit is a cheap 304, not a full re-fetch.
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
