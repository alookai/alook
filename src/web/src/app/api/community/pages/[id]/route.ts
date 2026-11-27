import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { getPrimaryDb } from "@/lib/db"
import { fetchPageHost, pageHostOrigin } from "@/lib/community/page-viewer.server"

export const DELETE = withAuth(communityActorPolicy(), async (_req, ctx) => {
  const actor = requireBot(ctx.actor)
  if (!actor.ok) return actor.response
  const db = getPrimaryDb(ctx.env.DB)
  const page = await queries.communityPage.getOwnedPage(db, ctx.params!.id!, actor.bot.userId)
  if (!page) return NextResponse.json({ error: "Page not found" }, { status: 404 })
  const origin = pageHostOrigin(ctx.env.ALOOK_PAGE_ORIGIN)
  if (!origin || !ctx.env.ALOOK_PAGE_HOST || !ctx.env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(ctx.env.ALOOK_PAGE_SERVICE_KEY) < 32) return NextResponse.json({ error: "Page host unavailable" }, { status: 503 })
  try {
    const response = await fetchPageHost(ctx.env.ALOOK_PAGE_HOST, origin, `/alook/resources/${page.artifactId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${ctx.env.ALOOK_PAGE_SERVICE_KEY}`, "x-alook-subject": actor.bot.userId }, signal: AbortSignal.timeout(30_000),
    })
    await response.body?.cancel()
    if (!response.ok) return NextResponse.json({ error: "Page deletion failed; retry" }, { status: 503 })
    await queries.communityPage.deleteOwnedPage(db, page.id, actor.bot.userId)
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "private, no-store" } })
  } catch { return NextResponse.json({ error: "Page deletion failed; retry" }, { status: 503 }) }
})
