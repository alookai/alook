import { nanoid } from "nanoid"
import {
  MAX_SERVER_RAIL_REQUEST_BYTES,
  projectServerRailCommit,
  queries,
  serverRailCommitRequestSchema,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

export const PATCH = withAuth(async (req, ctx) => {
  const rawBody = await req.text()
  if (new TextEncoder().encode(rawBody).byteLength > MAX_SERVER_RAIL_REQUEST_BYTES) {
    return writeError("request body too large", 413)
  }

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    return writeError("invalid request body", 400)
  }

  const request = serverRailCommitRequestSchema.safeParse(parsedBody)
  if (!request.success) return writeError("invalid server rail commands", 400)

  const db = getDb(ctx.env.DB)
  const snapshot = await queries.communityServerRail.readServerRailSnapshot(db, ctx.userId)
  const projection = projectServerRailCommit(snapshot, request.data, () => nanoid())
  if (!projection.ok) return writeError(projection.error, projection.status)

  await queries.communityServerRail.applyServerRailProjection(
    db,
    ctx.userId,
    projection.value,
  )

  return writeJSON({ createdFolderIds: projection.value.createdFolderIds })
})
