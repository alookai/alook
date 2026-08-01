import { NextRequest } from "next/server"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  withD1Retry,
  nonIdempotentWriteAllowed,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVER_DESCRIPTION_LENGTH,
  ROLES,
  WS_EVENTS,
  slugify,
} from "@alook/shared"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { serverIconUrl } from "@/lib/community/storage"

/**
 * GET — list "my servers", serving both a human and a bot via the unified actor
 * (plan §4 FOLD of /agent/listServers, §9 phase 4). Both list via
 * `listUserServers(actor.userId)`; the response is a superset (full server rows
 * incl. id+name+icon) — the web client uses the UI fields, the bot's daemon
 * projects each row down to `{id, name}` (the old lean listServers shape).
 * No actor.kind branch needed: `userId` is common to both callers.
 */
export const GET = withCommunityActor(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // `withD1Retry` (D1-armor: no-fallback list read; retry to truth).
  const rows = await withD1Retry(() => queries.communityServer.listUserServers(db, ctx.actor.userId), {
    route: "servers/list",
  })
  const servers = rows.map((row) => ({ ...row, icon: serverIconUrl(row) }))
  return writeJSON({ servers })
})

/**
 * POST — create a server. Human-only: there is no bot create-server verb today,
 * so a bot actor is rejected 403 (`rejectBot`) rather than silently granted a
 * new capability by the actor unification (plan §5 — capabilities are explicit,
 * not "whatever the route happens to accept").
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor)
  if (denied) return denied

  const db = getDb(ctx.env.DB)

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
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

  // `nonIdempotentWriteAllowed` (state 4b), NOT retried: createServer mints a
  // fresh server (+ owner member + default category) with a generated id and NO
  // unique guard on the name (servers may share names), so a blind retry on a
  // transient would create a SECOND server. No idempotency key → a user's
  // response-lost retry can create a duplicate; accepted because it's visible +
  // deletable (not silent, unlike the DM double-create). A transient surfaces as
  // a 500 the user can retry — safer than a silent double-create.
  const { server, ownerMember } = await nonIdempotentWriteAllowed(
    {
      reason:
        "createServer mints a fresh server (id + owner member + default category); no name-unique guard and no idempotency key, so a retry would create a duplicate server",
    },
    () =>
      queries.communityServer.createServer(db, {
        name,
        description,
        ownerId: ctx.actor.userId,
      }),
  )

  fanOutToServerMembers(server.id, {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: server.id,
    member: {
      id: ownerMember.id,
      userId: ctx.actor.userId,
      name: ownerMember.userName,
      discriminator: ownerMember.userDiscriminator,
      avatar: ownerMember.userImage ?? undefined,
      role: ROLES.OWNER,
      joinedAt: ownerMember.joinedAt,
    },
  })

  return writeJSON({ server }, 201)
})
