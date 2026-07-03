"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityFolder } from "@/components/community/_types"

/**
 * Fetches the user's server-folder groupings for the rail.
 *
 * The API returns raw folder rows; we materialise the `FolderServer` view
 * shape (with `initial`) here so consumers get render-ready data. The
 * transform is deterministic per row so it's safe inside the query function.
 */
type RawFolder = {
  id: string
  name: string
  position: number
  servers: Array<{ id: string; name: string; icon?: string | null }>
}

export type FoldersResponse = { folders: CommunityFolder[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_FOLDERS: readonly CommunityFolder[] = Object.freeze([])

export const foldersQueryFn = async (): Promise<FoldersResponse> => {
  const data = await apiFetch<{ folders: RawFolder[] }>("/api/community/server-folders")
  const folders: CommunityFolder[] = data.folders.map((f) => ({
    id: f.id,
    name: f.name,
    position: f.position ?? 0,
    servers: f.servers.map((s) => ({
      id: s.id,
      name: s.name,
      initial: avatarInitial(s.name),
      icon: s.icon ?? null,
    })),
  }))
  return { folders }
}

export function useFolders(): UseQueryResult<FoldersResponse> & {
  folders: CommunityFolder[]
} {
  const query = useQuery({
    queryKey: communityKeys.folders(),
    queryFn: foldersQueryFn,
  })
  return {
    ...query,
    folders: query.data?.folders ?? (EMPTY_FOLDERS as CommunityFolder[]),
  }
}
