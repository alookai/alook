import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { queries, readBoundedJsonRequest } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { pageServiceAuthorized } from "@/lib/community/page-viewer.server"
import { requireMessageSurfaceCommunicationAccess } from "@/lib/community/permissions"

const bodySchema = z.strictObject({ subject: z.string().min(1).max(128), artifactId: z.string().min(1).max(128) })

export async function POST(req: NextRequest) {
  const { env } = await getCloudflareContext({ async: true })
  if (!pageServiceAuthorized(req, env.ALOOK_PAGE_SERVICE_KEY)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const raw = await readBoundedJsonRequest(req, 2048)
  const body = bodySchema.safeParse(raw.ok ? raw.value : null)
  if (!body.success) return NextResponse.json({ error: "Invalid Page access request" }, { status: 400 })
  const db = getPrimaryDb(env.DB)
  const page = await queries.communityPage.getReadablePageForArtifact(db, body.data.artifactId, body.data.subject)
  const communication = page ? await requireMessageSurfaceCommunicationAccess(db, page.channelId, body.data.subject) : null
  return NextResponse.json({ role: page ? communication?.ok ? "editor" : "viewer" : null }, { headers: { "Cache-Control": "private, no-store" } })
}
