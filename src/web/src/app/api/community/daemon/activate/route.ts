import { NextResponse } from "next/server"
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
import { forceCloseCommunityMachinesByDoNames } from "@/lib/community/machine-disconnect"
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
    return NextResponse.json({ error: "invalid JSON body", sessionOutcome: "not_committed" }, { status: 400 })
  }
  const parsed = CommunityDaemonActivateRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten(), sessionOutcome: "not_committed" },
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
    const { runtimeReport, expectedMachineId, ...rest } = parsed.data
    const result = await queries.communityMachineSession.transitionMachineSessionEpoch(db, {
      type: "rotate",
      tokenId,
      metadata: {
        ...rest,
        availableRuntimes: runtimeReport,
      },
      expectedMachineId,
    })

    // Rotation already committed. Cleanup and the user-visible event are
    // independent post-commit branches: neither delays the response, and a
    // stuck historical DO close cannot suppress machine.created.
    const cleanup = Promise.resolve()
      .then(() => forceCloseCommunityMachinesByDoNames(ctx.env, result.revokedDoNames))
      .catch((err) => {
        log.warn("post-commit machine cleanup failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    const publish = (async () => {
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
        await broadcastToUser(result.userId, event)
      }
    })().catch((err) => {
      log.warn("post-commit machine event failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    })
    for (const work of [cleanup, publish]) {
      try {
        ctx.waitUntil?.(work)
      } catch (err) {
        log.warn("failed to register post-commit activation work", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const body: CommunityDaemonActivateResponse = {
      credential: result.credential,
      machineId: result.machineId,
      expiresAt: null,
      sessionOutcome: "committed",
    }
    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof queries.communityMachineSession.MachineSessionRotationError) {
      const errorBody = { error: err.message, sessionOutcome: err.sessionOutcome }
      switch (err.kind) {
        case "unknown":
          return NextResponse.json(errorBody, { status: 404 })
        case "expired":
          return NextResponse.json(errorBody, { status: 410 })
        case "revoked":
        case "already_active":
        case "expected_machine_required":
        case "machine_mismatch":
          return NextResponse.json(errorBody, { status: 409 })
      }
    }
    log.error("activate failed", { err: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: err instanceof Error ? `activate failed: ${err.message}` : "activate failed" },
      { status: 500 }
    )
  }
})
