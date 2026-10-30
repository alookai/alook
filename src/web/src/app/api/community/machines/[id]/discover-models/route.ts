import { withCommunityActor } from "@/lib/middleware/community-actor"
import { discoverModels } from "@/lib/community/discover-models.server"

export const POST = withCommunityActor((req, ctx) => discoverModels(req, { ...ctx, kind: ctx.actor.kind, userId: ctx.actor.kind === "bot" ? ctx.actor.ownerUserId : ctx.actor.userId }))
