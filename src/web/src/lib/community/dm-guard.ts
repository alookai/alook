import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"
import { requireNotBlocked } from "./permissions"

export type GuardDmOpenResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string; code?: string }

/**
 * Shared DM-open gate (debt #9), extracted verbatim from the human DM route
 * (`/api/community/dm` POST) so bot DM-open goes through the SAME gating a
 * human does — not a looser path. Single signature, one opts flag:
 * `callerKind` defaults to `"human"` (preserves existing behavior for the
 * human route with zero call-site changes).
 *
 * - 400 `cannot_dm_self` if `senderId === peerId`.
 * - Peer missing/soft-deleted → 404 `user_not_found` (both caller kinds —
 *   preserves pass-as-human for the human route; a `crk_`-authenticated bot
 *   caller has no "pass as human" risk, so 404 here is just "not found",
 *   not deliberate obfuscation).
 * - Peer is a bot: allowed if `senderId` is the bot's owner, else requires
 *   `areFriends`. On friend-check failure:
 *     - `callerKind: "human"` → 404 `user_not_found` (pass-as-human).
 *     - `callerKind: "bot"` → 403 `not_friends` (crk_ authenticated; no
 *       pass-as-human risk to preserve).
 * - `requireNotBlocked` → 403 `blocked` — EXCEPT when `senderId` is the
 *   peer's owner, matching the existing human route's `isOwner` skip
 *   exactly (a deliberate behavior-preservation decision, not an oversight:
 *   a verbatim extraction without this skip would change existing
 *   production behavior for owners DMing their own bot).
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

  if (peer.isBot === true) {
    const isOwner = peer.ownerUserId === senderId
    if (!isOwner) {
      const areFriends = await queries.communityFriendship.areFriends(db, senderId, peerId)
      if (!areFriends) {
        return callerKind === "bot"
          ? { ok: false, status: 403, error: "not friends with this bot", code: "not_friends" }
          : { ok: false, status: 404, error: "user not found", code: "user_not_found" }
      }
    }
    if (!isOwner) {
      const blocked = await requireNotBlocked(db, senderId, peerId)
      // `requireNotBlocked` only ever fails with 403 — narrow the wider
      // `PermissionError` status union to satisfy this function's return type.
      if (!blocked.ok) return { ok: false, status: 403, error: blocked.error, code: "blocked" }
    }
  } else {
    const blocked = await requireNotBlocked(db, senderId, peerId)
    if (!blocked.ok) return { ok: false, status: 403, error: blocked.error, code: "blocked" }
  }

  return { ok: true }
}
