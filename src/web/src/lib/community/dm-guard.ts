import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"
import { requireNotBlocked } from "./permissions"

export type GuardDmOpenResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string; code?: string }

/**
 * Shared DM-open gate (debt #9), shared with the human DM create door
 * (`POST /api/community/channels`, `type: "dm"`) so bot DM-open uses the SAME gating a
 * human does — not a looser path. Single signature, one opts flag:
 * `callerKind` defaults to `"human"` (preserves existing behavior for the
 * human route with zero call-site changes).
 *
 * - 400 `cannot_dm_self` if `senderId === peerId`.
 * - Peer missing/soft-deleted → 404 `user_not_found` (both caller kinds —
 *   preserves pass-as-human for the human route; a `crk_`-authenticated bot
 *   caller has no "pass as human" risk, so 404 here is just "not found",
 *   not deliberate obfuscation).
 * - Block always wins, including owner ↔ own-bot pairs.
 * - Every human/bot pairing requires `areFriends`; that query includes the
 *   owner ↔ own-bot implicit friendship. On friend-check failure:
 *     - human caller targeting a bot → 404 `user_not_found` (pass-as-human).
 *     - every other caller/peer pairing → 403 `not_friends`.
 * - `requireNotBlocked` → 403 `blocked` before the friendship check.
 */
export async function guardDmOpen(
  db: Database,
  senderId: string,
  peerId: string,
  opts?: { callerKind?: "human" | "bot" }
): Promise<GuardDmOpenResult> {
  const callerKind = opts?.callerKind ?? "human"

  if (senderId === peerId) {
    return { ok: false, status: 400, error: "cannot DM yourself", code: "cannot_dm_self" }
  }

  const peer = await queries.user.getUserInternal(db, peerId)
  if (!peer || peer.deletedAt !== null) {
    return { ok: false, status: 404, error: "user not found", code: "user_not_found" }
  }

  const blocked = await requireNotBlocked(db, senderId, peerId)
  if (!blocked.ok) {
    return { ok: false, status: 403, error: blocked.error, code: "blocked" }
  }

  const accepted = await queries.communityFriendship.areFriends(db, senderId, peerId)
  if (!accepted) {
    if (peer.isBot === true && callerKind === "human") {
      return { ok: false, status: 404, error: "user not found", code: "user_not_found" }
    }
    return { ok: false, status: 403, error: "not friends", code: "not_friends" }
  }

  return { ok: true }
}
