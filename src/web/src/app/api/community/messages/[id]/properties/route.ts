import { NextRequest } from "next/server"
import {
  isStoredChannelType,
  messagePropertyCapabilities,
  type MessagePropertyMutation,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { listForumTagsForActor, mutateForumTagsForActor } from "@/lib/community/forum-tag-operations"
import { listReactionsForActor, removeReactionForActor, setReactionForActor } from "@/lib/community/reaction-operations"
import { resolveMessageRefForBot } from "@/lib/community/resolve-message-ref"
import { requireBot, withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { queries } from "@alook/shared"

type PropertyType = MessagePropertyMutation["type"]

function parseProperty(raw: unknown):
  | { ok: true; property: { type: PropertyType; value: unknown } }
  | { ok: false; response: Response } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, response: writeError("property must be an object", 400) }
  }
  const keys = Object.keys(raw).sort()
  if (keys.length !== 2 || keys[0] !== "type" || keys[1] !== "value") {
    return { ok: false, response: writeError("property must contain exactly type and value", 400) }
  }
  const property = raw as { type?: unknown; value?: unknown }
  if (property.type !== "tag" && property.type !== "emoji" && property.type !== "mark") {
    return { ok: false, response: writeError("unknown property type", 400) }
  }
  return { ok: true, property: { type: property.type, value: property.value } }
}

function hasExactMutationKeys(raw: unknown): raw is {
  channel: unknown
  seq: unknown
  property: unknown
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  const keys = Object.keys(raw).sort()
  return keys.length === 3
    && keys[0] === "channel"
    && keys[1] === "property"
    && keys[2] === "seq"
}

async function resolveTarget(
  db: ReturnType<typeof getDb>,
  userId: string,
  raw: unknown,
) {
  const target = await resolveMessageRefForBot(db, userId, raw, {
    requireSurfaceAccess: true,
  })
  if (!target.ok) return target

  const channelType = await queries.communityChannel.getChannelType(db, target.channelId)
  if (!isStoredChannelType(channelType)) {
    return { ok: false as const, status: 404, error: "message not found" }
  }
  return { ...target, channelType }
}

function unsupportedProperty(type: PropertyType, channelType: string, capabilities: readonly PropertyType[]) {
  return writeJSON({
    error: `property type '${type}' is not supported for ${channelType} messages`,
    hint: `supported property types: ${capabilities.join(", ")}`,
  }, 400)
}

export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  if (ctx.params?.id !== "resolve") return writeError("not found", 404)

  const url = new URL(req.url)
  const ref = url.searchParams.get("ref") ?? ""
  const seq = Number(url.searchParams.get("seq"))
  const db = getDb(ctx.env.DB)
  const target = await resolveTarget(db, gate.bot.userId, { channel: ref, seq })
  if (!target.ok) return writeError(target.error, target.status)

  const capabilities = [...messagePropertyCapabilities(target.channelType)]
  const properties = []
  for (const capability of capabilities) {
    if (capability === "tag") {
      const result = await listForumTagsForActor(db, {
        messageId: target.messageId,
        userId: gate.bot.userId,
      })
      if (!result.ok) return writeError(result.error, result.status)
      properties.push({ type: "tag" as const, value: result.value })
    } else if (capability === "emoji") {
      const result = await listReactionsForActor(db, {
        messageId: target.messageId,
        userId: gate.bot.userId,
      })
      if (!result.ok) return writeError(result.error, result.status)
      properties.push({ type: "emoji" as const, value: result.value })
    } else {
      const marked = await queries.communityMessageMark.isMessageMarked(
        db,
        gate.bot.userId,
        target.messageId,
      )
      properties.push({ type: "mark" as const, value: marked })
    }
  }
  return writeJSON({ capabilities, properties })
})

async function mutate(req: NextRequest, ctx: Parameters<Parameters<typeof withCommunityActor>[0]>[1], action: "set" | "remove") {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  if (ctx.params?.id !== "resolve") return writeError("not found", 404)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid JSON body", 400)
  }

  const db = getDb(ctx.env.DB)
  const target = await resolveTarget(db, gate.bot.userId, raw)
  if (!target.ok) return writeError(target.error, target.status)

  if (!hasExactMutationKeys(raw)) {
    return writeError("request must contain exactly channel, seq, and property", 400)
  }
  const parsed = parseProperty(raw.property)
  if (!parsed.ok) return parsed.response

  const capabilities = messagePropertyCapabilities(target.channelType)
  if (!capabilities.includes(parsed.property.type)) {
    return unsupportedProperty(parsed.property.type, target.channelType, capabilities)
  }

  if (parsed.property.type === "tag") {
    const result = await mutateForumTagsForActor(db, {
      messageId: target.messageId,
      userId: gate.bot.userId,
      action,
      tags: parsed.property.value,
    })
    if (!result.ok) return writeError(result.error, result.status)
    return writeJSON({
      type: "tag",
      value: result.value.tags,
      changed: result.value.changed,
    })
  }

  if (parsed.property.type === "mark") {
    if (parsed.property.value !== true) {
      return writeError("mark value must be true", 400)
    }
    const changed = action === "set"
      ? await queries.communityMessageMark.markMessage(db, {
          userId: gate.bot.userId,
          channelId: target.channelId,
          messageId: target.messageId,
        }) !== null
      : await queries.communityMessageMark.unmarkMessage(db, {
          userId: gate.bot.userId,
          messageId: target.messageId,
        }) !== null
    return writeJSON({ type: "mark", value: true, changed })
  }

  const result = action === "set"
    ? await setReactionForActor(db, {
      messageId: target.messageId,
      userId: gate.bot.userId,
      emoji: parsed.property.value,
    })
    : await removeReactionForActor(db, {
      messageId: target.messageId,
      userId: gate.bot.userId,
      emoji: parsed.property.value,
    })
  if (!result.ok) return writeError(result.error, result.status)
  return writeJSON({ type: "emoji", value: result.value.emoji, changed: result.value.changed })
}

export const PUT = withCommunityActor((req, ctx) => mutate(req, ctx, "set"))
export const DELETE = withCommunityActor((req, ctx) => mutate(req, ctx, "remove"))
