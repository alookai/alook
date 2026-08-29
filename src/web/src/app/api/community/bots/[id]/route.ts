import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  buildBotAvatarKey,
  canonicalUserImage,
  isOwnedBotAvatarObjectKey,
} from "@/lib/community/storage"
import { nanoid } from "nanoid"
import {
  queries,
  CommunityBotPatchRequestSchema,
  WS_EVENTS,
  makeRuntimeConfig,
  resolveModelConfig,
  formatHandle,
  createLogger,
  resolveReasoningEffort,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import {
  pushBotEventToMachine,
  pushAgentModelSwitchToMachine,
  pushAgentProviderSwitchToMachine,
  pushAgentRuntimeConfigUpdateToMachine,
} from "@/lib/community/bot-push"
import { fanOutProfileUpdate, fanOutToServerMembers } from "@/lib/community/fanout"
import { scheduleCommunityMediaCleanup } from "@/lib/community/community-media-cleanup"

const log = createLogger({ service: "community-bot-update" })

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!bot) return writeError("bot not found", 404)
  return writeJSON({
    bot: {
      id: bot.id,
      name: bot.name,
      discriminator: bot.discriminator,
      image: canonicalUserImage(bot.id, bot.image, bot.avatarVersion),
      avatarVersion: bot.avatarVersion,
      ownerUserId: bot.ownerUserId,
      description: bot.description,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      lastRefreshContextAt: bot.lastRefreshContextAt,
      machineId: bot.machineId,
      runtime: bot.runtime,
      modelName: bot.modelName,
      reasoningEffort: bot.reasoningEffort,
      runtimeConfigRevision: bot.runtimeConfigRevision,
    },
  })
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
  const configRequested = restartChanged || "reasoningEffort" in body
  let runtimeDescriptor: import("@alook/shared").CommunityMachineRuntime | null = null
  let botOnline = false

  if (configRequested) {
    if (!before.machineId || !targetRuntime || !before.runtime) {
      return writeError("bot has no active runtime binding", 409)
    }
    botOnline = await queries.communityMachine.isBotOnline(db, id)
    if (restartChanged && !botOnline) {
      return writeError("bot is offline — bring it online before changing provider or model", 409)
    }
    const machine = await queries.communityBot.getMachineForOwner(db, before.machineId, ctx.userId)
    if (!machine) return writeError("machine not found", 404)
    runtimeDescriptor = machine.availableRuntimes.find((item) => item.id === targetRuntime) ?? null
    if (!runtimeDescriptor) return writeError(`runtime ${targetRuntime} not available on this machine`, 400)
    if (restartChanged && runtimeDescriptor.status === "unhealthy") {
      return writeError(`runtime ${targetRuntime} is currently unavailable on this machine`, 400)
    }
  }
  const storedModel = nextModel !== undefined ? nextModel : (before.modelName ?? null)
  const requestedEffort = "reasoningEffort" in body
    ? (body.reasoningEffort ?? null)
    : before.reasoningEffort
  const effortResolution = resolveReasoningEffort(runtimeDescriptor, storedModel, requestedEffort)
  if ("reasoningEffort" in body && requestedEffort !== null && !effortResolution.supported && !restartChanged) {
    return writeError(`reasoning effort ${requestedEffort} is not supported by this runtime/model`, 400)
  }
  const storedEffort = configRequested
    ? effortResolution.canonicalEffort
    : before.reasoningEffort
  const effortChanged = storedEffort !== before.reasoningEffort
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
  const publicProfile = nameChanged
    ? await queries.communityUserProfile.getProfile(db, id)
    : null

  const updated = await queries.communityBot.updateBot(db, id, ctx.userId, {
    name: body.name,
    description: body.description,
    image: body.image ?? undefined,
  })
  if (!updated) return writeError("bot not found", 404)

  if (nameChanged) {
    await fanOutProfileUpdate({
      id,
      name: updated.name,
      discriminator: updated.discriminator,
      aboutMe: publicProfile?.aboutMe ?? "",
      bannerColor: publicProfile?.bannerColor ?? null,
      identity: {
        kind: "bot",
        ownerProfile: { id: before.ownerUserId },
      },
    })
  }

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
  let application: "unchanged" | "next_turn" | "saved_not_applied" = "unchanged"
  let runtimeConfigRevision = before.runtimeConfigRevision
  if (restartChanged && before.machineId && before.runtime && targetRuntime) {
    let wrote: Awaited<ReturnType<typeof queries.communityBot.updateBotRuntimeConfig>>
    try {
      wrote = await queries.communityBot.updateBotRuntimeConfig(db, id, ctx.userId, {
        runtime: targetRuntime,
        modelName: storedModel,
        reasoningEffort: storedEffort,
      })
    } catch (persistErr) {
      log.error("bot_runtime_switch_persist_failed", {
        botId: id,
        persistErr: String(persistErr),
      })
      return writeError("failed to persist runtime configuration", 500)
    }
    if (!wrote) return writeError("runtime binding disappeared before persistence", 409)
    runtimeConfigRevision = wrote.runtimeConfigRevision
    const config = makeRuntimeConfig({
      runtime: targetRuntime,
      model: resolveModelConfig(targetRuntime, storedModel),
      reasoningEffort: storedEffort ?? undefined,
      runtimeConfigRevision,
      agentName: updated.name,
      agentHandle: `@${formatHandle(updated.name, updated.discriminator)}`,
    })
    const launchId = nanoid()
    let result = { sent: 0, deliveryError: true }
    try {
      result = runtimeChanged
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
    } catch (pushErr) {
      log.warn("bot_runtime_switch_delivery_deferred", {
        botId: id,
        machineId: before.machineId,
        runtimeConfigRevision,
        pushErr: String(pushErr),
      })
    }
    deliveryError = result.deliveryError
    applied = result.sent > 0
    application = applied ? "next_turn" : "saved_not_applied"
    if (!applied) {
      log.warn("bot_runtime_switch_delivery_deferred", {
        botId: id,
        machineId: before.machineId,
        runtimeFrom: before.runtime,
        runtimeTo: targetRuntime,
        modelFrom: before.modelName ?? null,
        modelTo: storedModel,
        runtimeConfigRevision,
        deliveryError,
      })
    }
  } else if (effortChanged && before.machineId && targetRuntime) {
    let wrote: Awaited<ReturnType<typeof queries.communityBot.updateBotRuntimeConfig>>
    try {
      wrote = await queries.communityBot.updateBotRuntimeConfig(db, id, ctx.userId, {
        runtime: targetRuntime,
        modelName: storedModel,
        reasoningEffort: storedEffort,
      })
    } catch (persistErr) {
      log.error("bot_reasoning_effort_persist_failed", {
        botId: id,
        persistErr: String(persistErr),
      })
      return writeError("failed to persist reasoning effort", 500)
    }
    if (!wrote) return writeError("runtime binding disappeared before persistence", 409)
    runtimeConfigRevision = wrote.runtimeConfigRevision
    if (!botOnline) {
      return writeJSON({
        bot: {
          id,
          name: updated.name,
          description: updated.description,
          image: canonicalUserImage(id, updated.image, updated.avatarVersion),
          avatarVersion: updated.avatarVersion,
          runtime: targetRuntime,
          modelName: storedModel,
          reasoningEffort: storedEffort,
          runtimeConfigRevision,
        },
        applied: false,
        deliveryError: false,
        application: "saved_not_applied",
      })
    }
    let result = { sent: 0, deliveryError: true }
    try {
      result = await pushAgentRuntimeConfigUpdateToMachine(ctx.env, before.machineId, {
        agentId: id,
        config: makeRuntimeConfig({
          runtime: targetRuntime,
          model: resolveModelConfig(targetRuntime, storedModel),
          reasoningEffort: storedEffort ?? undefined,
          runtimeConfigRevision,
          agentName: updated.name,
          agentHandle: `@${formatHandle(updated.name, updated.discriminator)}`,
        }),
      })
    } catch (pushErr) {
      log.warn("bot_reasoning_effort_delivery_deferred", {
        botId: id,
        machineId: before.machineId,
        runtimeConfigRevision,
        pushErr: String(pushErr),
      })
    }
    deliveryError = result.deliveryError
    applied = result.sent > 0
    application = applied ? "next_turn" : "saved_not_applied"
  }

  return writeJSON({
    bot: {
      id,
      name: updated.name,
      description: updated.description,
      image: canonicalUserImage(id, updated.image, updated.avatarVersion),
      avatarVersion: updated.avatarVersion,
      runtime: targetRuntime,
      modelName: nextModel !== undefined ? nextModel : (before.modelName ?? null),
      reasoningEffort: storedEffort,
      runtimeConfigRevision,
    },
    applied,
    deliveryError,
    application,
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

  let executionContext: ExecutionContext
  try {
    ({ ctx: executionContext } = await getCloudflareContext({ async: true }))
  } catch {
    return writeError("internal error", 500)
  }

  const ok = await queries.communityBot.softDeleteBot(db, id, ctx.userId)
  if (!ok) return writeError("bot not found", 404)

  scheduleCommunityMediaCleanup(ctx.env.COMMUNITY_MEDIA, executionContext, {
    keys: [
      ...(before.avatarObjectKey && isOwnedBotAvatarObjectKey(before.avatarObjectKey, id)
        ? [before.avatarObjectKey]
        : []),
      buildBotAvatarKey(id),
    ],
    warning: {
      event: "community_bot_avatar_cleanup_failed",
      fields: { botId: id, phase: "bot_delete" },
    },
  })

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
