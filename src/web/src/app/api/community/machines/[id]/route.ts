import { NextRequest, NextResponse } from "next/server"
import { queries, withD1Retry, WS_EVENTS } from "@alook/shared"
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
  // `withD1Retry` (D1-armor state 2): access-check read — a transient would
  // 404 the owner's own machine (mis-judged state); retry to truth.
  const machine = await withD1Retry(
    () => queries.communityMachine.getMachineByIdForUser(db, ctx.userId, id),
    { route: "machines/delete/get-machine" },
  )
  if (!machine) return writeError("machine not found", 404)

  // Bot preflight — communityBotBinding has ON DELETE RESTRICT, so a raw
  // delete would error if bots exist. Surface UX-side: 409 with the bot list,
  // require `{ cascade: true }` to actually delete.
  // `withD1Retry` (D1-armor state 2): a transient here would wrongly report zero
  // bots and skip the cascade-guard 409 (a delete that should have warned about
  // bound bots proceeds). Retry to truth.
  const bots = await withD1Retry(
    () => queries.communityBot.listBotsBoundToMachine(db, id, ctx.userId),
    { route: "machines/delete/list-bots" },
  )
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
    // `withD1Retry` (D1-armor state 2): snapshot memberships BEFORE the delete —
    // a transient here would miss MEMBER_LEAVE fan-outs; retry to truth.
    const priorMemberships = await withD1Retry(
      () => queries.communityBot.listBotServerMemberships(db, bot.id, ctx.userId),
      { route: "machines/delete/bot-memberships" },
    )
    // `withD1Retry` (D1-armor state 3): idempotent (owner-scoped UPDATE guarded
    // by isNull(deletedAt) — a re-run on an already-tombstoned bot is a no-op).
    await withD1Retry(() => queries.communityBot.softDeleteBot(db, bot.id, ctx.userId), {
      route: "machines/delete/soft-delete-bot",
    })
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
  // `withD1Retry` (D1-armor state 3): idempotent (UPDATE revoked_at WHERE null).
  const { doNames } = await withD1Retry(
    () => queries.communityMachine.revokeCredentialsForMachine(db, ctx.userId, id),
    { route: "machines/delete/revoke-credentials" },
  )

  // Also revoke any live `crk_` for this machine — a reconnect rotates `cmk_`
  // but keeps machine.id stable; without this, stale runner keys would outlive
  // the credential that authorized them.
  // `withD1Retry` (D1-armor state 3): idempotent (UPDATE revoked_at WHERE null).
  await withD1Retry(() => queries.communityMachine.revokeRunnerKeysForMachine(db, id), {
    route: "machines/delete/revoke-runner-keys",
  })

  // 2. Force-close every live WS Durable Object for those credentials.
  //    The DO is keyed by `sha256(bearer).slice(0,32)`, so a machine that
  //    rotated credentials has one DO per historical bearer.
  await forceCloseCommunityMachinesByDoNames(ctx.env, doNames)

  // 3. Delete the row. Credential + runner-key rows cascade.
  // `withD1Retry` (D1-armor state 3): idempotent (DELETE by owner+id — a re-run
  // deletes nothing and returns null).
  await withD1Retry(() => queries.communityMachine.deleteMachineForUser(db, ctx.userId, id), {
    route: "machines/delete/delete-machine",
  })

  // 4. Tell the owner's other tabs the machine is gone.
  const event: CommunityWsEvent = { type: WS_EVENTS.MACHINE_REMOVED, machineId: id }
  broadcastToUserSafe(ctx.userId, event)

  return new NextResponse(null, { status: 204 })
})
