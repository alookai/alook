import { withAuth } from "@/lib/middleware/auth-policy"
import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const directory = await queries.communityChannel.listChannelRefDirectoryForUser(
    db,
    ctx.userId,
  )
  const resources = await readCommunityResourceBundle(db, ctx.userId, { serverIds: directory.map(row => row.id), channelIds: directory.flatMap(row => row.channels.map(channel => channel.id)) })
  return writeJSON({ directory, resources })
})
