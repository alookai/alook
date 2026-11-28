import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { queries, readBoundedJsonRequest } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { pageHostOrigin, pageServiceAuthorized, pageTicketHash } from "@/lib/community/page-viewer.server"

const bodySchema = z.strictObject({ ticket: z.string().length(43), origin: z.string() })

export async function POST(req: NextRequest) {
  const { env } = await getCloudflareContext({ async: true })
  if (!pageServiceAuthorized(req, env.ALOOK_PAGE_SERVICE_KEY)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const raw = await readBoundedJsonRequest(req, 2048)
  const body = bodySchema.safeParse(raw.ok ? raw.value : null)
  const origin = pageHostOrigin(env.ALOOK_PAGE_ORIGIN)
  if (!body.success || !origin || body.data.origin !== origin) return NextResponse.json({ error: "Invalid viewer ticket" }, { status: 400 })
  const hash = pageTicketHash(body.data.ticket)
  const db = getPrimaryDb(env.DB)
  const result = hash ? await queries.communityPage.consumePageViewerTicket(db, hash, origin, new Date().toISOString()) : null
  if (!result) return NextResponse.json({ error: "Invalid viewer ticket" }, { status: 404, headers: { "Cache-Control": "private, no-store" } })
  const user = await queries.user.getUserPublic(db, result.userId)
  if (!user) return NextResponse.json({ error: "Invalid viewer ticket" }, { status: 404 })
  return NextResponse.json({ subject: user.id, name: user.name, pageId: result.page.id, artifactId: result.page.artifactId, sourceMessageId: result.page.messageId }, {
    headers: { "Cache-Control": "private, no-store" },
  })
}
