import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

const VALID_PREFIXES = ["mention:", "reply:", "thread:"]

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let body: { eventKey?: string; eventKeys?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const keys = body.eventKeys ?? (body.eventKey ? [body.eventKey] : [])
  if (keys.length === 0) return writeError("provide eventKey or eventKeys", 400)

  const invalid = keys.find((k) => !VALID_PREFIXES.some((p) => k.startsWith(p)))
  if (invalid) return writeError(`invalid eventKey: ${invalid}`, 400)

  const db = getDb(ctx.env.DB)
  await queries.communityInbox.dismissEvents(db, ctx.userId, keys)

  return writeJSON({ ok: true })
})
