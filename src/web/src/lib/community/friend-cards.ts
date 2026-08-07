import type { FriendCard } from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"

/** The peer-row shape the friendship bucket queries project (listAgentFriends). */
export type FriendPeerRow = {
  peerUserId: string
  name: string
  discriminator: string | null
  aboutMe?: string | null
  statusText?: string | null
  statusEmoji?: string | null
}

/**
 * Bulk WS presence check — one `/presence/users` round-trip across every peer
 * id. Best-effort: any failure defaults everyone offline (presence is a live
 * nicety, never blocks the list). Extracted from the pre-fold flat `listFriends`
 * verb so the split bucket endpoints (friends/accepted, friends/pending) share
 * one presence path instead of each re-implementing it.
 */
export async function resolvePresence(
  env: Parameters<typeof wsDoFetch>[0],
  peerIds: string[],
  label: string,
): Promise<Set<string>> {
  const unique = [...new Set(peerIds)]
  if (unique.length === 0) return new Set()
  try {
    const resp = await wsDoFetch(
      env,
      "/presence/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: unique }),
      },
      { label },
    )
    if (resp.ok) {
      const data = (await resp.json()) as { online: string[] }
      if (Array.isArray(data.online)) return new Set(data.online)
    }
  } catch {
    /* presence best-effort — default everyone offline */
  }
  return new Set()
}

/**
 * Project a friendship peer row to the lean bot `FriendCard` (the shape
 * `alook friend list` renders). `presence` is looked up in the pre-resolved
 * online set. Identical mapping to the pre-fold flat verb's `toCard`, lifted so
 * every bucket endpoint's bot arm emits the same card.
 */
export function toFriendCard(row: FriendPeerRow, onlineSet: Set<string>): FriendCard {
  return {
    userId: row.peerUserId,
    handle: `${row.name}#${row.discriminator ?? "0000"}`,
    name: row.name,
    bio: row.aboutMe ?? null,
    statusText: row.statusText ?? null,
    statusEmoji: row.statusEmoji ?? null,
    presence: onlineSet.has(row.peerUserId) ? "online" : "offline",
  }
}
