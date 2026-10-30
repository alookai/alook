import { withAuth } from "@/lib/middleware/auth-policy"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { resolveChannelRefTarget } from "@/lib/community/channel-ref-target"

export const GET = withAuth(humanAuthPolicy, async (req, ctx) => {
  const result = await resolveChannelRefTarget(getPrimaryDb(ctx.env.DB), ctx.userId, req.nextUrl.searchParams.get("ref") ?? "")
  if ("error" in result) return writeError(result.error === 400 ? "invalid channel ref" : result.error === 403 ? "forbidden" : "not found", result.error)
  return writeJSON(result)
})
