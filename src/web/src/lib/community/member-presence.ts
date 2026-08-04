import { wsDoFetch } from "@/lib/broadcast"
import type { CommunityCliMemberStatus as MemberStatus } from "@alook/shared"

// One bulk presence read for a set of user ids — NEVER a per-member fan-out.
// The ws-do worker fans out to each user's DO internally, so this stays a
// single web-worker subrequest regardless of roster size. Best-effort: on any
// failure the set is empty (callers then report `online: false`) — this is a
// point-in-time snapshot, not a live signal, and we never fabricate presence.
export async function fetchOnlineUserIds(
  env: Env,
  userIds: string[],
  label: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  try {
    const resp = await wsDoFetch(
      env,
      "/presence/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: userIds }),
      },
      { label },
    )
    if (resp.ok) {
      const data = (await resp.json()) as { online: string[] }
      if (Array.isArray(data.online)) return new Set(data.online)
    }
  } catch {
    /* presence best-effort — default everyone offline, never fabricate */
  }
  return new Set()
}

// Map a profile's raw status columns into the structured wire shape. `text`
// defaults to "" (unset), `emoji` stays null (unset) — the reader decides how
// to render; we never join them into a string.
export function toMemberStatus(row: {
  statusEmoji: string | null
  statusText: string | null
}): MemberStatus {
  return { emoji: row.statusEmoji ?? null, text: row.statusText ?? "" }
}
