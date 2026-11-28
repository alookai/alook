import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { AlookPageCommentSchema, queries, readBoundedJsonRequest } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { pageServiceAuthorized } from "@/lib/community/page-viewer.server"
import { sendPageComment } from "@/lib/community/page-comments.server"

const bodySchema = AlookPageCommentSchema.extend({
  nonce: z.string().min(1).max(128).optional(),
  subject: z.string().min(1).max(128),
  artifactId: z.string().min(1).max(128),
})

export async function POST(req: NextRequest) {
  const { env } = await getCloudflareContext({ async: true })
  if (!pageServiceAuthorized(req, env.ALOOK_PAGE_SERVICE_KEY)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const raw = await readBoundedJsonRequest(req, 64 * 1024)
  const body = bodySchema.safeParse(raw.ok ? raw.value : null)
  if (!body.success) return NextResponse.json({ error: "Invalid Page comment" }, { status: 400 })
  const db = getPrimaryDb(env.DB)
  const page = await queries.communityPage.getReadablePageForArtifact(db, body.data.artifactId, body.data.subject, body.data.sourceMessageId)
  if (!page) return NextResponse.json({ error: "Page not found" }, { status: 404 })
  return sendPageComment(db, body.data.subject, env, page, body.data)
}
