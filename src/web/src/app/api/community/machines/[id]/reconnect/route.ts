import { queries, withD1Retry } from "@alook/shared"
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
    // `withD1Retry` (D1-armor state 3): idempotent per user — revokes any prior
    // pending token then inserts one (partial-unique one-pending-per-user), so a
    // retried transient leaves exactly one pending token, never two.
    const token = await withD1Retry(
      () => queries.communityMachine.createReconnectPairingToken(db, ctx.userId, id),
      { route: "machines/reconnect/pairing-token" },
    )
    // Reconnect rotates `cmk_` on next /activate. Runner keys are tied to
    // the machine but authorized by `cmk_`, so stale `crk_` rows would
    // outlive the credential that authorized them. Revoke them here so the
    // daemon re-enrolls after reconnect.
    // `withD1Retry` (D1-armor state 3): idempotent (UPDATE revoked_at WHERE
    // revoked_at IS NULL — a re-run matches zero live rows, same state).
    await withD1Retry(() => queries.communityMachine.revokeRunnerKeysForMachine(db, id), {
      route: "machines/reconnect/revoke-runner-keys",
    })
    return writeJSON({ tokenId: token.tokenId, expiresAt: token.expiresAt })
  } catch (err) {
    if (err instanceof Error && /not owned by user/.test(err.message)) {
      return writeError("machine not found", 404)
    }
    throw err
  }
})
