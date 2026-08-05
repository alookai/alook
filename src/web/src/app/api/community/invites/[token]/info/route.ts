import { withOptionalAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { serverIconUrl } from "@/lib/community/storage"
import { avatarInitial } from "@/lib/community/avatar"

// How many member avatars the landing page previews. A small strip ("who's
// already here") + the total count reads warmer than a bare number; the client
// summarizes the rest as "+N" from `memberCount`.
const MEMBER_PREVIEW_LIMIT = 5

// Viewable logged-in OR anonymous — the invite landing page loads before any
// login (preview-first journey), so `withOptionalAuth` never 401s on a missing
// session. The invite token stays the sole capability: an invalid/expired token
// is still rejected below (404/410). Every field returned is the same for any
// caller (no per-viewer projection), so the handler ignores `ctx.userId`.
export const GET = withOptionalAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("missing token", 400)

  const db = getDb(ctx.env.DB)

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

  const memberCount = await queries.communityMember.countMembers(db, invite.serverId)

  // Inviter ("Invited by …") — resolved server-side in this same request. The
  // FK is `set null` on user delete, so `createdBy` may be null (legacy/pruned
  // invites); the field is then simply null and the client omits the line.
  const inviter = invite.createdBy
    ? (await queries.user.getUsersByIds(db, [invite.createdBy]))[0] ?? null
    : null

  // Member-avatar strip — a handful of faces reads warmer than a bare count.
  // `listMembers` is unpaginated; slice to the preview cap. Same
  // `image ?? initial` fallback the member-list projection uses.
  //
  // Names are deliberately NOT exposed here (product call): the preview is a
  // face strip for warmth, not a roster. Since a server has no public/private
  // flag and invite tokens are forwardable, dropping names keeps a token holder
  // from harvesting who's in the server by name. The avatar is a photo URL or a
  // single-letter initial (derived server-side); the initial never ships the
  // full name.
  const members = await queries.communityMember.listMembers(db, invite.serverId)
  const memberPreview = members.slice(0, MEMBER_PREVIEW_LIMIT).map((m) => ({
    id: m.userId,
    avatar: m.userImage ?? avatarInitial(m.userName),
  }))

  return writeJSON({
    serverId: invite.serverId,
    serverName: server.name,
    serverIcon: serverIconUrl(server),
    serverDescription: server.description ?? "",
    memberCount,
    memberPreview,
    inviter: inviter
      ? { id: inviter.id, name: inviter.name, avatar: inviter.image ?? avatarInitial(inviter.name) }
      : null,
  })
})
