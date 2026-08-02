import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // `withD1Retry` (D1-armor state 3): idempotent per user — revokes any prior
  // pending token then inserts one (partial-unique one-pending-per-user), so a
  // retried transient never leaves two live pending tokens.
  const { tokenId, expiresAt } = await withD1Retry(
    () => queries.communityMachine.createPairingToken(db, ctx.userId),
    { route: "machines/pair/pairing-token" },
  )
  return writeJSON({ tokenId, expiresAt })
})
