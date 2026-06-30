import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import type { CommunityWsEvent } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"
import { forceCloseCommunityMachine } from "@/lib/community/machine-disconnect"

export const DELETE = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  if (!id) return writeError("machine id is required", 400)

  // Scope-first lookup — cross-user returns 404, never 403.
  const machine = await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, id)
  if (!machine) return writeError("machine not found", 404)

  // 1. Revoke the token so future reconnects are rejected.
  const tokenId = queries.communityMachine.tokenIdFromMachineUuid(machine.machineUuid)
  await queries.communityMachine.revokeToken(db, tokenId)

  // 2. Force-close any live WS connection on the DO.
  await forceCloseCommunityMachine(ctx.env, tokenId)

  // 3. Delete the row.
  await queries.communityMachine.deleteMachineForUser(db, ctx.userId, id)

  // 4. Tell the owner's other tabs the machine is gone.
  const event: CommunityWsEvent = { type: "community:machine.removed", machineId: id }
  broadcastToUser(ctx.userId, event).catch(() => {})

  return new NextResponse(null, { status: 204 })
})
