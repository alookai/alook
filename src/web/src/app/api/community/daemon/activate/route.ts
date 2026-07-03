import { NextRequest, NextResponse } from "next/server"
import {
  queries,
  createLogger,
  CommunityDaemonActivateRequestSchema,
  WS_EVENTS,
  type CommunityDaemonActivateResponse,
  type CommunityMachineCreated,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { broadcastToUser } from "@/lib/broadcast"
import { withCommunityPairingToken } from "@/lib/middleware/community-pairing-token"

const log = createLogger({ service: "community/daemon/activate" })

/**
 * POST /api/community/daemon/activate
 *
 * Exchanges a pending pairing token (`cmt_...`, Bearer) for a long-lived
 * daemon credential (`cmk_...`). Server atomically revokes the pairing
 * token so it can't be re-used. See plans/remove-community-mode.md
 * "Contract 1" for the wire spec.
 */
export const POST = withCommunityPairingToken(async (req, ctx) => {
  const tokenId = ctx.rawTokenId

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityDaemonActivateRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const db = getDb(ctx.env.DB)

  try {
    // Map wire field `runtimeReport` → persisted `availableRuntimes` so the
    // first `community:machine.created` broadcast carries the detected
    // runtimes. Without this the row is inserted with `[]` and no chips
    // appear until the WS `ready` frame lands (which never arrives if the
    // daemon dies between HTTP activate and WS connect).
    const { runtimeReport, ...rest } = parsed.data
    const result = await queries.communityMachine.activateMachineCredential(db, tokenId, {
      ...rest,
      availableRuntimes: runtimeReport,
    })

    // Broadcast machine.created carrying the pairing token so the client
    // side (which is waiting on that specific `cmt_` to resolve) can
    // reconcile its pending state. The WS DO's later `ready`-frame handler
    // does NOT re-emit machine.created — activation is the single source
    // of the create event.
    const machine = await queries.communityMachine.getMachineByIdForUser(
      db,
      result.userId,
      result.machineId
    )
    if (machine) {
      const summary = queries.communityMachine.toSummary(machine)
      const event: CommunityMachineCreated = {
        type: WS_EVENTS.MACHINE_CREATED,
        machine: summary,
        tokenId,
      }
      broadcastToUser(result.userId, event).catch((err) => {
        log.warn("broadcast after activate failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }

    const body: CommunityDaemonActivateResponse = {
      credential: result.credential,
      machineId: result.machineId,
      expiresAt: null,
    }
    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof queries.communityMachine.ActivateCredentialError) {
      switch (err.kind) {
        case "unknown":
          return NextResponse.json({ error: err.message }, { status: 404 })
        case "expired":
          return NextResponse.json({ error: err.message }, { status: 410 })
        case "revoked":
        case "already_active":
          return NextResponse.json({ error: err.message }, { status: 409 })
      }
    }
    log.error("activate failed", { err: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: "activate failed" }, { status: 500 })
  }
})
