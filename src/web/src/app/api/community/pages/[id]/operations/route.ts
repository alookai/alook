import { NextResponse } from "next/server"
import { AlookPageOperationSchema, queries, readBoundedJsonRequest } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { getPrimaryDb } from "@/lib/db"
import { pageAccessRole } from "@/lib/community/page-access.server"
import { fetchPageHost, pageHostOrigin } from "@/lib/community/page-viewer.server"

export const POST = withAuth(communityActorPolicy(), async (req, ctx) => {
  const bot = requireBot(ctx.actor)
  if (!bot.ok) return bot.response
  const body = await readBoundedJsonRequest(req, 2 * 1024 * 1024)
  const parsed = AlookPageOperationSchema.safeParse(body.ok ? body.value : null)
  if (!parsed.success) return NextResponse.json({ error: "Invalid Page operation" }, { status: 400 })
  const db = getPrimaryDb(ctx.env.DB)
  const page = await queries.communityPage.getPublishedPage(db, ctx.params!.id!, bot.bot.userId)
  if (!page) return NextResponse.json({ error: "Page not found" }, { status: 404 })
  if (parsed.data.kind === "write" || parsed.data.kind === "action") {
    if (await pageAccessRole(db, page.artifactId, bot.bot.userId) !== "editor") return NextResponse.json({ error: "Page is read only" }, { status: 403 })
  }
  const origin = pageHostOrigin(ctx.env.ALOOK_PAGE_ORIGIN)
  if (!origin || !ctx.env.ALOOK_PAGE_HOST || !ctx.env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(ctx.env.ALOOK_PAGE_SERVICE_KEY) < 32) return NextResponse.json({ error: "Page host unavailable" }, { status: 503 })
  try {
    const response = await fetchPageHost(ctx.env.ALOOK_PAGE_HOST, origin, `/alook/operate/${page.artifactId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.env.ALOOK_PAGE_SERVICE_KEY}`, "x-alook-subject": bot.bot.userId },
      body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(30_000),
    })
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } })
  } catch { return NextResponse.json({ error: "Page host unavailable" }, { status: 503 }) }
})
