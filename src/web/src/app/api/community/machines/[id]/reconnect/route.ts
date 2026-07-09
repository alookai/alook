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
    // Reconnect rotates `cmk_` on next /activate. Runner keys are tied to
    // the machine but authorized by `cmk_`, so stale `crk_` rows would
    // outlive the credential that authorized them. Revoke them here so the
    // daemon re-enrolls after reconnect.
    await queries.communityMachine.revokeRunnerKeysForMachine(db, id)
    return writeJSON({ tokenId: token.tokenId, expiresAt: token.expiresAt })
  } catch (err) {
    if (err instanceof Error && /not owned by user/.test(err.message)) {
      return writeError("machine not found", 404)
    }
    throw err
  }
})
