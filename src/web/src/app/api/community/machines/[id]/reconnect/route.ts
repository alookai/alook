import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

// Reconnect: mint a new pending pairing token bound to the existing
// machineId. No `cmk_` rotation happens here — the daemon runs
// `alook daemon start --machine-key <new cmt_>`, and /activate reuses the
// same machine row while inserting a fresh credential and revoking the
// prior one (which force-closes the live DO).
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
    if (err instanceof queries.communityMachine.PendingTokenAlreadyExistsError) {
      return writeError(
        "You already have an unused pairing token — cancel it first",
        409
      )
    }
    if (err instanceof Error && /not owned by user/.test(err.message)) {
      return writeError("machine not found", 404)
    }
    throw err
  }
})
