import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

type ResolveMessageRefResult =
  | { ok: true; messageId: string; channelId: string }
  | { ok: false; status: number; error: string }

export async function resolveMessageRefForBot(
  db: Database,
  userId: string,
  raw: unknown,
  opts: { requireSurfaceAccess: boolean },
): Promise<ResolveMessageRefResult> {
  const body = (raw ?? {}) as { channel?: unknown; seq?: unknown }
  const ref = typeof body.channel === "string" ? body.channel : ""
  const seq = typeof body.seq === "number" ? body.seq : NaN
  if (!ref) return { ok: false, status: 400, error: "channel ref required" }
  if (!Number.isInteger(seq) || seq <= 0) {
    return { ok: false, status: 400, error: "valid seq required" }
  }

  const resolved = await resolveTargetForMember(db, userId, ref, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) {
    return { ok: false, status: resolved.error, error: resolved.message }
  }

  if (opts.requireSurfaceAccess) {
    const access = await requireMessageSurfaceAccess(
      db,
      resolved.channelId,
      userId,
    )
    if (!access.ok) {
      return { ok: false, status: access.status, error: access.error }
    }
  }

  const message = await queries.communityMessage.getMessageIdentityByChannelAndSeq(
    db,
    { channelId: resolved.channelId },
    seq,
  )
  if (!message) return { ok: false, status: 404, error: "message not found" }
  return {
    ok: true,
    messageId: message.id,
    channelId: message.channelId,
  }
}
