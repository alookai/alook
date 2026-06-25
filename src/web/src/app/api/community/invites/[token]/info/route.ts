import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (!token) return writeError("missing token", 400)

  const { env } = await getCloudflareContext({ async: true })
  const db = getDb(env.DB)

  const invite = await queries.communityInvite.getInviteByToken(db, token)
  if (!invite) return writeError("invite not found or expired", 404)

  const now = new Date().toISOString()
  if (invite.expiresAt && invite.expiresAt <= now) {
    return writeError("invite expired", 410)
  }
  if (invite.maxUses !== null && (invite.uses ?? 0) >= invite.maxUses) {
    return writeError("invite has reached max uses", 410)
  }

  const server = await queries.communityServer.getServer(db, invite.serverId)
  if (!server) return writeError("server not found", 404)

  const members = await queries.communityMember.listMembers(db, invite.serverId)

  return writeJSON({
    serverName: server.name,
    serverIcon: server.icon,
    serverDescription: server.description ?? "",
    memberCount: members.length,
  })
}
