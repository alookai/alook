import { NextResponse } from "next/server"
import { AlookPageCommentSchema, COMMUNITY_RESOURCE_CONTRACT_VERSION, queries, readBoundedJsonRequest, requestedCommunityContract } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { sendPageComment } from "@/lib/community/page-comments.server"

export const POST = withAuth(humanAuthPolicy, async (req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const raw = await readBoundedJsonRequest(req, 64 * 1024)
  if (!raw.ok) return NextResponse.json({ error: "Invalid Page comment" }, { status: raw.reason === "oversized" ? 413 : 400 })
  const body = AlookPageCommentSchema.safeParse(raw.value)
  if (!body.success) return NextResponse.json({ error: "Invalid Page comment" }, { status: 400 })
  const page = await queries.communityPage.getReadablePage(db, ctx.params!.id!, ctx.userId, body.data.sourceMessageId)
  if (!page) return NextResponse.json({ error: "Page source not found" }, { status: 404 })
  return sendPageComment(db, ctx.userId, ctx.env, page, body.data, requestedCommunityContract(req.headers) ?? COMMUNITY_RESOURCE_CONTRACT_VERSION)
})
