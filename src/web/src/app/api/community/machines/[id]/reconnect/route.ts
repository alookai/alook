import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

// Reconnect: mint a new pending pairing token bound to the existing
// machineId. Minting is deliberately non-disruptive: credential and runner
// rotation happens only when the exact-machine reconnect command activates
// this token.
export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  if (!id) return writeError("machine id is required", 400)

  try {
    const token = await queries.communityMachine.createReconnectPairingToken(
      db,
      ctx.userId,
      id
    )
    return writeJSON({ tokenId: token.tokenId, expiresAt: token.expiresAt })
  } catch (err) {
    if (err instanceof Error && /not owned by user/.test(err.message)) {
      return writeError("machine not found", 404)
    }
    throw err
  }
})
