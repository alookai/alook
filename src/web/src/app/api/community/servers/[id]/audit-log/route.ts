import { NextRequest } from "next/server"
import {
  queries,
  withD1Retry,
  DEFAULT_AUDIT_LOG_PAGE_SIZE,
  MAX_AUDIT_LOG_PAGE_SIZE,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerAdmin } from "@/lib/community/permissions"
import { parseBoundedInt } from "@/lib/community/messages"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const url = new URL(req.url)
  const action = url.searchParams.get("action") ?? undefined
  const before = url.searchParams.get("before") ?? undefined
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_AUDIT_LOG_PAGE_SIZE,
    MAX_AUDIT_LOG_PAGE_SIZE,
  )

  // `withD1Retry` (D1-armor: no-fallback audit-log read; retry to truth).
  const logs = await withD1Retry(
    () =>
      queries.communityAuditLog.listAuditLog(db, serverId, {
        action,
        before,
        limit,
      }),
    { route: "servers/audit-log" },
  )

  return writeJSON({ entries: logs })
})
