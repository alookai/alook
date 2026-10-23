import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  return writeJSON(await queries.communityServerFolder.listFolders(db, ctx.userId))
})
