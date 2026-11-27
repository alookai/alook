import { createHash } from "node:crypto"
import { AlookPageSourceSchema, pageCoverContentType, queries } from "@alook/shared"
import { NextResponse } from "next/server"
import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { getPrimaryDb } from "@/lib/db"
import { pageCoverKey, readPageCoverBody } from "@/lib/community/page-cover.server"

const cacheHeaders = { "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" }
const failure = (status: number, error: string) => NextResponse.json({ error }, { status, headers: cacheHeaders })

export const GET = withAuth(humanAuthPolicy, async (request, ctx) => {
  const source = AlookPageSourceSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!source.success) return failure(400, "Invalid Page source")
  const page = await queries.communityPage.getReadablePage(getPrimaryDb(ctx.env.DB), ctx.params!.id!, ctx.userId, source.data.sourceMessageId)
  if (!page) return failure(404, "Page cover not found")
  if (!ctx.env.COMMUNITY_MEDIA) return failure(503, "Page cover storage unavailable")
  const image = await ctx.env.COMMUNITY_MEDIA.get(pageCoverKey(page.id))
  if (!image) return failure(404, "Page cover not found")
  const etag = image.customMetadata?.sha256 ? `"${image.customMetadata.sha256}"` : image.httpEtag
  const headers = { ...cacheHeaders, "Content-Type": image.httpMetadata?.contentType ?? "application/octet-stream", ETag: etag }
  const matched = request.headers.get("if-none-match")?.split(",").some(value => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")
  if (matched) { await image.body.cancel(); return new Response(null, { status: 304, headers }) }
  return new Response(image.body, { headers })
})

export const PUT = withAuth(communityActorPolicy(), async (request, ctx) => {
  const actor = requireBot(ctx.actor)
  if (!actor.ok) return actor.response
  const db = getPrimaryDb(ctx.env.DB)
  const page = await queries.communityPage.getOwnedPage(db, ctx.params!.id!, actor.bot.userId)
  if (!page) return failure(404, "Page not found")
  if (!ctx.env.COMMUNITY_MEDIA) return failure(503, "Page cover storage unavailable")
  const body = await readPageCoverBody(request)
  if (!body.ok) return failure(body.status, "Page cover must be at most 2 MiB")
  const contentType = pageCoverContentType(body.bytes)
  if (!contentType || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== contentType) return failure(415, "A PNG, JPEG or WebP Page cover is required")
  const sha256 = createHash("sha256").update(body.bytes).digest("hex")
  await ctx.env.COMMUNITY_MEDIA.put(pageCoverKey(page.id), body.bytes, { httpMetadata: { contentType }, customMetadata: { ownerId: actor.bot.userId, sha256 } })
  if (!await queries.communityPage.getOwnedPage(db, page.id, actor.bot.userId)) {
    await ctx.env.COMMUNITY_MEDIA.delete(pageCoverKey(page.id))
    return failure(404, "Page not found")
  }
  return NextResponse.json({ id: page.id, etag: `"${sha256}"` }, { headers: cacheHeaders })
})
