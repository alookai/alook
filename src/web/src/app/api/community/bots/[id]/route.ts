import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import {
  queries,
  withD1Retry,
  nonIdempotentWriteAllowed,
  CommunityBotPatchRequestSchema,
  WS_EVENTS,
  makeRuntimeConfig,
  resolveModelConfig,
  runtimeSupportsModel,
  formatHandle,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { pushBotEventToMachine, pushAgentModelSwitchToMachine } from "@/lib/community/bot-push"
import { broadcastToUser } from "@/lib/broadcast"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!bot) return writeError("bot not found", 404)
  return writeJSON({ bot })
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const id = ctx.params?.id as string
  const [body, err] = await parseBody(req, CommunityBotPatchRequestSchema)
  if (err) return err
  const db = getDb(ctx.env.DB)

  const before = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!before) return writeError("bot not found", 404)

  const nameChanged = body.name !== undefined && body.name !== before.name
  const descriptionChanged =
    body.description !== undefined && body.description !== before.description
  // `model` alone is a valid patch. Storage/wire/UI all speak `string | null`,
  // so "did it change?" is a plain string comparison — no ModelConfig here.
  const nextModel = body.model === undefined ? undefined : (body.model ?? null)
  const modelChanged = nextModel !== undefined && nextModel !== (before.modelName ?? null)

  // antigravity ignores the model at launch; reject a non-null model on it (and
  // on any runtime that doesn't support one). `before.runtime === null`
  // (unknown runtime) is allowed — only antigravity is excluded.
  if (nextModel !== null && nextModel !== undefined && !runtimeSupportsModel(before.runtime)) {
    return writeError(`runtime ${before.runtime} does not support a model selection`, 400)
  }
  // Will we push bot:updated to the daemon? (Iff name/description changed —
  // image-only is display-only and doesn't affect the system prompt.) If so,
  // resolve the owner handle BEFORE mutating the row: the frame shape must stay
  // consistent with bot:added, and if the owner can't be resolved (soft-delete,
  // integrity bug) we must fail WITHOUT having already written — otherwise a
  // retry sees `before === updated`, computes no change, and never pushes,
  // leaving the daemon's running system prompt permanently stale.
  const willPush = (nameChanged || descriptionChanged) && !!before.machineId
  const owner = willPush ? await queries.user.getUserPublic(db, before.ownerUserId) : null
  if (willPush && !owner) {
    return writeError("bot owner not resolvable — refusing to push a bot update with unknown ownership", 500)
  }

  // `withD1Retry` (state 3): updateBot sets fields to values, idempotent.
  const updated = await withD1Retry(
    () =>
      queries.communityBot.updateBot(db, id, ctx.userId, {
        name: body.name,
        description: body.description,
        image: body.image ?? undefined,
      }),
    { route: "bots/update" },
  )
  if (!updated) return writeError("bot not found", 404)

  if (willPush && owner && before.machineId) {
    await pushBotEventToMachine(ctx.env, before.machineId, {
      type: "bot:updated",
      botId: id,
      name: updated.name,
      discriminator: updated.discriminator,
      description: updated.description || undefined,
      ownerName: owner.name,
      ownerDiscriminator: owner.discriminator,
    })
  }

  // Model switch. D1 is authoritative — write the column regardless of daemon
  // reachability, then EXPEDITE via a push. NEVER 409: name/description writes
  // (and this one) must land even when the bot is offline. The audit row is
  // written only on confirmed delivery (`sent > 0`), so an offline/undelivered
  // switch persists silently and the next wake applies it.
  let applied = false
  let deliveryError = false
  if (modelChanged) {
    // A bot with no binding row (unbound / never paired) passes the
    // `getBotOwnedBy` 404 check above but has nothing to write the model onto.
    // Reject rather than echo a model the response would claim was saved while
    // a later GET reads the old value (UI/D1 divergence).
    const wrote = await withD1Retry(
      () => queries.communityBot.updateBotModel(db, id, ctx.userId, nextModel!),
      { route: "bots/update-model" },
    )
    if (!wrote) {
      return writeError("bot has no runtime binding — pair it to a machine before setting a model", 409)
    }

    const wakeCtx = await queries.communityBot.getBotWakeContext(db, id)
    if (wakeCtx.state === "ready") {
      const config = makeRuntimeConfig({
        runtime: wakeCtx.runtime,
        model: resolveModelConfig(wakeCtx.runtime, nextModel!),
        agentName: wakeCtx.name,
        agentHandle: `@${formatHandle(wakeCtx.name, wakeCtx.discriminator)}`,
      })
      const result = await pushAgentModelSwitchToMachine(ctx.env, wakeCtx.machineId, {
        agentId: id,
        config,
        launchId: nanoid(),
      })
      deliveryError = result.deliveryError
      applied = result.sent > 0

      if (applied) {
        // `nonIdempotentWriteAllowed` (4b), NOT retried: append-only audit; a
        // retry duplicates one benign log row (no user-visible state). Only
        // reached on confirmed delivery.
        const inserted = await nonIdempotentWriteAllowed(
          { reason: "append-only audit; a retry duplicates one benign log row" },
          () =>
            queries.communityBotAuditLog.insertBotAuditModelChanged(db, {
              botId: id,
              actorId: ctx.userId,
              from: before.modelName ?? null,
              to: nextModel!,
            }),
        )
        if (inserted) {
          try {
            await broadcastToUser(ctx.userId, {
              type: WS_EVENTS.BOT_AUDIT_EVENT,
              botId: id,
              id: inserted.id,
              kind: "model_changed",
              payload: { from: before.modelName ?? null, to: nextModel! },
              sessionId: null,
              launchId: null,
              createdAt: inserted.createdAt,
            })
          } catch {
            // Best-effort — D1 row is authoritative.
          }
        }
      }
    }
  }

  const changedFields: string[] = []
  if (body.name !== undefined) changedFields.push("name")
  if (body.description !== undefined) changedFields.push("description")
  if (body.image !== undefined) changedFields.push("image")
  if (modelChanged) changedFields.push("model")
  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_UPDATED,
    targetType: "user",
    targetId: id,
    changes: JSON.stringify({ botId: id, fields: changedFields }),
  })

  return writeJSON({
    bot: {
      id,
      name: updated.name,
      description: updated.description,
      image: updated.image,
      modelName: nextModel !== undefined ? nextModel : (before.modelName ?? null),
    },
    applied,
    deliveryError,
  })
})

export const DELETE = withAuth(async (_req, ctx) => {
  const id = ctx.params?.id as string
  const db = getDb(ctx.env.DB)

  // Fetch binding first so we can push bot:removed to the daemon after the
  // delete commits. If ownership check fails, softDeleteBot returns false and
  // this data is untouched — no cross-owner leak.
  const before = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!before) return writeError("bot not found", 404)

  // Snapshot server memberships BEFORE the delete removes them, so we can fan
  // out MEMBER_LEAVE per (server, botId) after the delete commits.
  const priorMemberships = await queries.communityBot.listBotServerMemberships(
    db,
    id,
    ctx.userId,
  )

  // `withD1Retry` (state 3): soft-delete sets deletedAt (idempotent — re-running
  // lands the same deleted state / 0-rows → 404), safe to retry.
  const ok = await withD1Retry(() => queries.communityBot.softDeleteBot(db, id, ctx.userId), {
    route: "bots/delete",
  })
  if (!ok) return writeError("bot not found", 404)

  for (const serverId of priorMemberships) {
    fanOutToServerMembers(serverId, {
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: id,
    })
  }

  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_DELETED,
    targetType: "user",
    targetId: id,
    changes: JSON.stringify({ botId: id }),
  })

  if (before.machineId) {
    await pushBotEventToMachine(ctx.env, before.machineId, {
      type: "bot:removed",
      botId: id,
    })
  }

  return new NextResponse(null, { status: 204 })
})
