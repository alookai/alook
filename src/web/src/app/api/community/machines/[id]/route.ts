import { NextRequest, NextResponse } from "next/server"
import { queries, WS_EVENTS } from "@alook/shared"
import type { CommunityWsEvent } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { broadcastToUserSafe, fanOutToServerMembers } from "@/lib/community/fanout"
import { forceCloseCommunityMachinesByDoNames } from "@/lib/community/machine-disconnect"

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  if (!id) return writeError("machine id is required", 400)

  // Scope-first lookup — cross-user returns 404, never 403.
  const machine = await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, id)
  if (!machine) return writeError("machine not found", 404)

  // Bot preflight — communityBotBinding has ON DELETE RESTRICT, so a raw
  // delete would error if bots exist. Surface UX-side: 409 with the bot list,
  // require `{ cascade: true }` to actually delete.
  const bots = await queries.communityBot.listBotsBoundToMachine(db, id, ctx.userId)
  let cascade = false
  try {
    const body = (await req.clone().json().catch(() => null)) as { cascade?: boolean } | null
    if (body?.cascade === true) cascade = true
  } catch {
    // no body — fine, cascade stays false
  }
  if (bots.length > 0 && !cascade) {
    return writeJSON({ error: "MACHINE_HAS_BOTS", bots }, 409)
  }

  // Soft-delete every bot bound to this machine (bots page cascade). Snapshot
  // each bot's server memberships BEFORE the delete removes them, so we can
  // fan out MEMBER_LEAVE per (server, botId) after each delete commits.
  for (const bot of bots) {
    const priorMemberships =
      await queries.communityBot.listBotServerMemberships(db, bot.id, ctx.userId)
    await queries.communityBot.softDeleteBot(db, bot.id, ctx.userId)
    for (const serverId of priorMemberships) {
      fanOutToServerMembers(serverId, {
        type: WS_EVENTS.MEMBER_LEAVE,
        serverId,
        userId: bot.id,
      })
    }
  }

  // 1. Revoke every active daemon credential for this machine (idempotent).
  //    Returns the DO-name suffixes so we can hit each live WS in step 2.
  const { doNames } = await queries.communityMachine.revokeCredentialsForMachine(
    db,
    ctx.userId,
    id
  )

  // Also revoke any live `crk_` for this machine — a reconnect rotates `cmk_`
  // but keeps machine.id stable; without this, stale runner keys would outlive
  // the credential that authorized them.
  await queries.communityMachine.revokeRunnerKeysForMachine(db, id)

  // 2. Force-close every live WS Durable Object for those credentials.
  //    The DO is keyed by `sha256(bearer).slice(0,32)`, so a machine that
  //    rotated credentials has one DO per historical bearer.
  await forceCloseCommunityMachinesByDoNames(ctx.env, doNames)

  // 3. Delete the row. Credential + runner-key rows cascade.
  await queries.communityMachine.deleteMachineForUser(db, ctx.userId, id)

  // 4. Tell the owner's other tabs the machine is gone.
  const event: CommunityWsEvent = { type: WS_EVENTS.MACHINE_REMOVED, machineId: id }
  broadcastToUserSafe(ctx.userId, event)

  return new NextResponse(null, { status: 204 })
})
