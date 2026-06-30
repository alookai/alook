import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { forceCloseCommunityMachine } from "@/lib/community/machine-disconnect"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  if (!id) return writeError("machine id is required", 400)

  const rotated = await queries.communityMachine.rotatePairingTokenForMachine(
    db,
    ctx.userId,
    id
  )
  if (!rotated) return writeError("machine not found", 404)

  // Boot any daemon still holding the old token so the user-visible state
  // matches the rotation. The new pending token won't be accepted until the
  // daemon redials with it.
  await forceCloseCommunityMachine(ctx.env, rotated.oldTokenId)

  return writeJSON({ tokenId: rotated.tokenId, expiresAt: rotated.expiresAt })
})
