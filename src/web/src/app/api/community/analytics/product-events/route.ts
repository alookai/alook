import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { queries } from "@alook/shared"
import { withOptionalAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { LANDING_CTA_NAMES } from "@/lib/product-analytics-contract"
import {
  deliverProductAnalytics, productAnalyticsAllowed, productAnalyticsIdentity, productAnalyticsMeasurementId,
  scheduleProductAnalytics, setProductAnalyticsCookies,
} from "@/lib/product-analytics-server"

const requestId = z.uuid()
const requestSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("landing_cta_clicked"), requestId, ctaName: z.enum(LANDING_CTA_NAMES) }).strict(),
  z.object({ event: z.literal("login_page_view"), requestId }).strict(),
  z.object({ event: z.literal("sign_in_failed"), requestId,
    method: z.enum(["email_otp", "github", "google", "apple"]),
    failureStage: z.enum(["send_code", "verify_code", "social_start"]),
  }).strict(),
  z.object({ event: z.literal("onboarding_enter_clicked"), requestId, serverId: z.string().min(1).max(100) }).strict(),
  z.object({ event: z.literal("invitation_link_visit"), requestId, token: z.string().min(1).max(200) }).strict(),
])

function sameOrigin(req: NextRequest) {
  try {
    const header = req.headers.get("origin")
    const origin = new URL(header ?? "")
    const host = req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() || req.headers.get("host") || req.nextUrl.host
    return header === origin.origin && ["http:", "https:"].includes(origin.protocol) && origin.host.toLowerCase() === host.toLowerCase()
  } catch { return false }
}

async function readBoundedBody(req: NextRequest): Promise<string | null> {
  if (!req.body || Number(req.headers.get("content-length")) > 2048) return null
  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let size = 0, body = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return body + decoder.decode()
      size += chunk.value.byteLength
      if (size > 2048) { await reader.cancel(); return null }
      body += decoder.decode(chunk.value, { stream: true })
    }
  } catch { return null } finally { reader.releaseLock() }
}

export const POST = withOptionalAuth(async (req, ctx) => {
  const headers = { "Cache-Control": "no-store" }
  if (!sameOrigin(req) || req.headers.has("authorization")) return NextResponse.json({ error: "forbidden" }, { status: 403, headers })
  if ((req.headers.get("content-type") ?? "").split(";", 1)[0] !== "application/json") return NextResponse.json({ error: "invalid body" }, { status: 400, headers })
  const text = await readBoundedBody(req)
  if (text === null) return NextResponse.json({ error: "invalid body" }, { status: 400, headers })
  const parsed = requestSchema.safeParse(await Promise.resolve().then(() => JSON.parse(text)).catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400, headers })
  const hasSession = req.cookies.has("better-auth.session_token") || req.cookies.has("__Secure-better-auth.session_token")
  if (hasSession && !ctx.userId) return NextResponse.json({ error: "session unavailable" }, { status: 503, headers })
  const db = getPrimaryDb(ctx.env.DB)
  if (ctx.userId) {
    const live = await queries.user.getUserInternal(db, ctx.userId)
    if (!live || live.isBot || live.deletedAt !== null) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers })
  }
  const cookies = req.headers.get("cookie") ?? ""
  if (!await productAnalyticsAllowed(db, ctx.env, cookies, ctx.userId)) return NextResponse.json({ recorded: false }, { headers })
  const input = parsed.data
  let serverId: string | undefined
  let sourceId: string | undefined
  let dedupeKey = `${input.event}:${input.requestId}`
  if (input.event === "onboarding_enter_clicked") {
    if (!ctx.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers })
    const server = await queries.productAnalytics.getOwnedServer(db, ctx.userId, input.serverId)
    if (!server) return NextResponse.json({ error: "not found" }, { status: 404, headers })
    serverId = server.id
    dedupeKey = `onboarding-enter:${ctx.userId}:${server.id}`
  }
  if (input.event === "invitation_link_visit") {
    const invite = await queries.productAnalytics.getInviteSource(db, input.token)
    if (!invite || (ctx.userId && invite.createdBy === ctx.userId)) return NextResponse.json({ recorded: false }, { headers })
    serverId = invite.serverId
    sourceId = invite.id
    dedupeKey = `invite-visit:${invite.id}:${input.requestId}`
  }
  const identity = productAnalyticsIdentity(cookies, Date.now(), productAnalyticsMeasurementId(ctx.env))
  const event = await queries.productAnalytics.recordEvent(db, {
    eventName: input.event, actorUserId: ctx.userId ?? null, serverId, sourceId, dedupeKey,
    clientId: identity.clientId, sessionId: identity.sessionId, createdAt: new Date().toISOString(),
    ...(input.event === "landing_cta_clicked" ? { ctaName: input.ctaName } : {}),
    ...(input.event === "sign_in_failed" ? { method: input.method, failureStage: input.failureStage } : {}),
  })
  if (event) await scheduleProductAnalytics(() => deliverProductAnalytics(db, ctx.env, event.row))
  const response = NextResponse.json({ recorded: Boolean(event) }, { headers })
  setProductAnalyticsCookies(response.cookies.set.bind(response.cookies), identity, req.nextUrl.protocol === "https:")
  return response
})
