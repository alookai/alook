import { MAX_MEMBERS_PAGE_SIZE } from "@alook/shared"
import type { Member } from "@/components/community/_types"
import { apiFetch } from "@/lib/api/client"

type MembersPage = {
  members: Member[]
  hasMore: boolean
  cursor?: string
}

export async function fetchAllServerMembers(serverId: string): Promise<Member[]> {
  const members: Member[] = []
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ limit: String(MAX_MEMBERS_PAGE_SIZE) })
    if (cursor) params.set("cursor", cursor)
    const page = await apiFetch<MembersPage>(
      `/api/community/servers/${encodeURIComponent(serverId)}/members?${params}`,
    )
    members.push(...page.members)
    cursor = page.hasMore ? page.cursor : undefined
    if (page.hasMore && !cursor) throw new Error("members page missing cursor")
  } while (cursor)
  return members
}
