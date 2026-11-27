import { AlookPageSourceSchema, readBoundedJsonRequest } from "@alook/shared"
import { NextResponse } from "next/server"
import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { issuePageViewer, pageHostOrigin } from "@/lib/community/page-viewer.server"
import { checkRateLimit } from "@/lib/rate-limit"

export const POST = withAuth(humanAuthPolicy, async (req, ctx) => {
  const origin = pageHostOrigin(ctx.env.ALOOK_PAGE_ORIGIN)
  if (!origin || !ctx.env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(ctx.env.ALOOK_PAGE_SERVICE_KEY) < 32) return NextResponse.json({ error: "Page host unavailable" }, { status: 503 })
  const rate = await checkRateLimit(ctx.env, "community:pageOpen", ctx.userId)
  if (!rate.allowed) return NextResponse.json({ error: "Too many Page opens" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } })
  const raw = await readBoundedJsonRequest(req, 2048)
  const body = AlookPageSourceSchema.safeParse(raw.ok ? raw.value : null)
  if (!body.success) return NextResponse.json({ error: "Invalid Page source" }, { status: 400 })
  const result = await issuePageViewer(getPrimaryDb(ctx.env.DB), ctx.params!.id!, ctx.userId, origin, Date.now(), body.data.sourceMessageId)
  return NextResponse.json(result ?? { error: "Page not found" }, {
    status: result ? 200 : 404, headers: { "Cache-Control": "private, no-store" },
  })
})
