import { wsDoFetch } from "@/lib/broadcast"
import { CommunityPresenceResultSchema, type CommunityPresenceResult, type CommunityCliMemberStatus as MemberStatus } from "@alook/shared"

const PRESENCE_FETCH_CHUNK_SIZE = 400

export async function fetchUserPresence(
  env: Env,
  userIds: string[],
  label: string,
): Promise<CommunityPresenceResult | undefined> {
  if (userIds.length === 0) return { online: [], offline: [] }
  const uniqueIds = [...new Set(userIds)]
  const online: string[] = []
  const offline: string[] = []
  try {
    for (let start = 0; start < uniqueIds.length; start += PRESENCE_FETCH_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(start, start + PRESENCE_FETCH_CHUNK_SIZE)
      const resp = await wsDoFetch(
        env,
        "/presence/users",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk }),
        },
        { label },
      )
      if (!resp.ok) return undefined
      const data = CommunityPresenceResultSchema.parse(await resp.json())
      const requested = new Set(chunk)
      if (![...data.online, ...data.offline].every((id) => requested.has(id))) return undefined
      online.push(...data.online)
      offline.push(...data.offline)
    }
    return { online, offline }
  } catch {
  }
  return undefined
}

export async function fetchOnlineUserIds(env: Env, userIds: string[], label: string): Promise<Set<string>> {
  return new Set((await fetchUserPresence(env, userIds, label))?.online ?? [])
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
