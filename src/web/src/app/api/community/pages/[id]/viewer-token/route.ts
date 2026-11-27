import { NextResponse } from "next/server"
import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { issuePageViewer, pageHostOrigin } from "@/lib/community/page-viewer.server"
import { checkRateLimit } from "@/lib/rate-limit"

export const POST = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const origin = pageHostOrigin(ctx.env.ALOOK_PAGE_ORIGIN)
  if (!origin || !ctx.env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(ctx.env.ALOOK_PAGE_SERVICE_KEY) < 32) return NextResponse.json({ error: "Page host unavailable" }, { status: 503 })
  const rate = await checkRateLimit(ctx.env, "community:pageOpen", ctx.userId)
  if (!rate.allowed) return NextResponse.json({ error: "Too many Page opens" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } })
  const result = await issuePageViewer(getPrimaryDb(ctx.env.DB), ctx.params!.id!, ctx.userId, origin)
  return NextResponse.json(result ?? { error: "Page not found" }, {
    status: result ? 200 : 404, headers: { "Cache-Control": "private, no-store" },
  })
})
