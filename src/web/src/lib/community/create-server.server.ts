import { NextRequest } from "next/server"
import { queries, MAX_SERVER_NAME_LENGTH, MAX_SERVER_DESCRIPTION_LENGTH, ROLES, WS_EVENTS, slugify } from "@alook/shared"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { canonicalUserImage } from "@/lib/community/storage"
import type { ResourceCreationContext } from "./create-bot.server"

export async function createServerForUser(req: NextRequest, ctx: ResourceCreationContext): Promise<Response> {
  const db = getDb(ctx.env.DB)

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body || typeof body !== "object" || !body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const trimmed = body.name.trim()
  if (!trimmed || trimmed.length > MAX_SERVER_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_SERVER_NAME_LENGTH} characters`, 400)
  }
  const name = slugify(trimmed)
  if (!name) {
    return writeError("name is required", 400)
  }

  let description: string | undefined
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return writeError("description must be a string", 400)
    }
    if (body.description.length > MAX_SERVER_DESCRIPTION_LENGTH) {
      return writeError(`description must be ≤ ${MAX_SERVER_DESCRIPTION_LENGTH} characters`, 400)
    }
    description = body.description
  }

  const denied = await ctx.beforeCreate?.()
  if (denied) return denied

  const { server, ownerMember } = await queries.communityServer.createServer(db, {
    name,
    description,
    ownerId: ctx.userId,
  })

  fanOutToServerMembers(server.id, {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: server.id,
    member: {
      id: ownerMember.id,
      userId: ctx.userId,
      name: ownerMember.userName,
      discriminator: ownerMember.userDiscriminator,
      avatar: canonicalUserImage(
        ownerMember.userId,
        ownerMember.userImage,
        ownerMember.userAvatarVersion,
      ) ?? undefined,
      avatarVersion: ownerMember.userAvatarVersion,
      role: ROLES.OWNER,
      joinedAt: ownerMember.joinedAt,
    },
  })

  return writeJSON({ server }, 201)
}
