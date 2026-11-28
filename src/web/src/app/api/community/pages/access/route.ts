import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { readBoundedJsonRequest } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { pageServiceAuthorized } from "@/lib/community/page-viewer.server"
import { pageAccessRole } from "@/lib/community/page-access.server"

const bodySchema = z.strictObject({ subject: z.string().min(1).max(128), artifactId: z.string().min(1).max(128) })

export async function POST(req: NextRequest) {
  const { env } = await getCloudflareContext({ async: true })
  if (!pageServiceAuthorized(req, env.ALOOK_PAGE_SERVICE_KEY)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const raw = await readBoundedJsonRequest(req, 2048)
  const body = bodySchema.safeParse(raw.ok ? raw.value : null)
  if (!body.success) return NextResponse.json({ error: "Invalid Page access request" }, { status: 400 })
  const db = getPrimaryDb(env.DB)
  return NextResponse.json({ role: await pageAccessRole(db, body.data.artifactId, body.data.subject) }, { headers: { "Cache-Control": "private, no-store" } })
}
