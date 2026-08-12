import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import {
  queries,
  CommunityBotPatchRequestSchema,
  WS_EVENTS,
  makeRuntimeConfig,
  resolveModelConfig,
  runtimeSupportsModel,
  formatHandle,
  createLogger,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import {
  pushBotEventToMachine,
  pushAgentModelSwitchToMachine,
  pushAgentProviderSwitchToMachine,
} from "@/lib/community/bot-push"
import { fanOutToServerMembers } from "@/lib/community/fanout"

const log = createLogger({ service: "community-bot-update" })

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
  const runtimeChanged = body.runtime !== undefined && body.runtime !== before.runtime
  const targetRuntime = body.runtime ?? before.runtime
  const nextModel = body.model !== undefined
    ? (body.model ?? null)
    : runtimeChanged
      ? null
      : undefined
  const modelChanged = nextModel !== undefined && nextModel !== (before.modelName ?? null)
  const restartChanged = runtimeChanged || modelChanged

  if (restartChanged) {
    if (!before.machineId || !targetRuntime || !before.runtime) {
      return writeError("bot has no active runtime binding", 409)
    }
    if (!(await queries.communityMachine.isBotOnline(db, id))) {
      return writeError("bot is offline — bring it online before changing provider or model", 409)
    }
    const machine = await queries.communityBot.getMachineForOwner(db, before.machineId, ctx.userId)
    if (!machine) return writeError("machine not found", 404)
    const runtime = machine.availableRuntimes.find((item) => item.id === targetRuntime)
    if (!runtime) return writeError(`runtime ${targetRuntime} not available on this machine`, 400)
    if (runtime.status === "unhealthy") {
      return writeError(`runtime ${targetRuntime} is currently unavailable on this machine`, 400)
    }
    if (nextModel !== null && nextModel !== undefined && !runtimeSupportsModel(targetRuntime)) {
      return writeError(`runtime ${targetRuntime} does not support a model selection`, 400)
    }
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

  const updated = await queries.communityBot.updateBot(db, id, ctx.userId, {
    name: body.name,
    description: body.description,
    image: body.image ?? undefined,
  })
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

  let applied = false
  let deliveryError = false
  if (restartChanged && before.machineId && before.runtime && targetRuntime) {
    const storedModel = nextModel !== undefined ? nextModel : (before.modelName ?? null)
    const config = makeRuntimeConfig({
      runtime: targetRuntime,
      model: resolveModelConfig(targetRuntime, storedModel),
      agentName: updated.name,
      agentHandle: `@${formatHandle(updated.name, updated.discriminator)}`,
    })
    const launchId = nanoid()
    const result = runtimeChanged
      ? await pushAgentProviderSwitchToMachine(ctx.env, before.machineId, {
          agentId: id,
          config,
          launchId,
          from: before.runtime,
          to: targetRuntime,
        })
      : await pushAgentModelSwitchToMachine(ctx.env, before.machineId, {
          agentId: id,
          config,
          launchId,
          from: before.modelName ?? null,
          to: storedModel,
        })
    deliveryError = result.deliveryError
    applied = result.sent > 0
    if (!applied) {
      return deliveryError
        ? writeError("failed to reach the bot daemon", 503)
        : writeError("bot is offline — bring it online before changing provider or model", 409)
    }

    try {
      const wrote = runtimeChanged
        ? await queries.communityBot.updateBotRuntime(db, id, ctx.userId, targetRuntime, storedModel)
        : await queries.communityBot.updateBotModel(db, id, ctx.userId, storedModel)
      if (!wrote) throw new Error("runtime binding disappeared before persistence")
    } catch (persistErr) {
      log.error("bot_runtime_switch_persist_failed", {
        botId: id,
        machineId: before.machineId,
        runtimeFrom: before.runtime,
        runtimeTo: targetRuntime,
        modelFrom: before.modelName ?? null,
        modelTo: storedModel,
        persistErr: String(persistErr),
      })
      return writeError("bot switched, but its runtime binding failed to persist", 500)
    }
  }

  return writeJSON({
    bot: {
      id,
      name: updated.name,
      description: updated.description,
      image: updated.image,
      runtime: targetRuntime,
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

  const ok = await queries.communityBot.softDeleteBot(db, id, ctx.userId)
  if (!ok) return writeError("bot not found", 404)

  for (const serverId of priorMemberships) {
    fanOutToServerMembers(serverId, {
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: id,
    })
  }


  if (before.machineId) {
    await pushBotEventToMachine(ctx.env, before.machineId, {
      type: "bot:removed",
      botId: id,
    })
  }

  return new NextResponse(null, { status: 204 })
})
