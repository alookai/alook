import { NextResponse } from "next/server"
import { z } from "zod"
import { queries, readBoundedJsonRequest } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { getPrimaryDb } from "@/lib/db"
import { registerPageArchive } from "@/lib/community/page-publish.server"

const bodySchema = z.strictObject({ archiveAttachmentId: z.string().min(1).max(128) })

export const POST = withAuth(communityActorPolicy(), async (req, ctx) => {
  const actor = requireBot(ctx.actor)
  if (!actor.ok) return actor.response
  const raw = await readBoundedJsonRequest(req, 2048)
  const body = bodySchema.safeParse(raw.ok ? raw.value : null)
  if (!body.success) return NextResponse.json({ error: "Invalid Page archive" }, { status: 400 })
  const result = await registerPageArchive(getPrimaryDb(ctx.env.DB), ctx.env, actor.bot.userId, body.data.archiveAttachmentId)
  return NextResponse.json(result.ok ? result.page : { error: result.error }, { status: result.ok ? 201 : result.status, headers: { "Cache-Control": "private, no-store" } })
})

const listSchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(512).optional() })
const cursorSchema = z.strictObject({ createdAt: z.string().min(1).max(64), id: z.string().min(1).max(128) })
export const GET = withAuth(communityActorPolicy(), async (req, ctx) => {
  const actor = requireBot(ctx.actor)
  if (!actor.ok) return actor.response
  const params = listSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!params.success) return NextResponse.json({ error: "Invalid Page list query" }, { status: 400 })
  let cursor: z.infer<typeof cursorSchema> | undefined
  if (params.data.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(params.data.cursor, "base64url").toString("utf8"))) }
    catch { return NextResponse.json({ error: "Invalid Page cursor" }, { status: 400 }) }
  }
  const result = await queries.communityPage.listOwnedPages(getPrimaryDb(ctx.env.DB), actor.bot.userId, { limit: params.data.limit, cursor })
  return NextResponse.json({ ...result, ...(result.nextCursor ? { nextCursor: Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") } : {}) }, { headers: { "Cache-Control": "private, no-store" } })
})
