import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { parseBoundedInt } from "@/lib/community/messages"

export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )
  const events = await queries.communityInbox.listForYouEvents(db, ctx.userId, { limit })
  return writeJSON({ events, limit })
})
