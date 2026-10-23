"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ServerRailEntry } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityFolder } from "@/lib/community/models/navigation"
import {
  useServerRailProjection,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

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
  servers: Array<{ id: string; name: string; icon?: string | null }>
}

export type FoldersResponse = { folders: CommunityFolder[]; topOrder?: ServerRailEntry[] | null }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_FOLDERS: readonly CommunityFolder[] = Object.freeze([])

export const foldersQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<FoldersResponse> => {
  const token = captureCommunityLiveSnapshotToken(context.client)
  const data = await apiFetch<{ folders: RawFolder[]; topOrder?: ServerRailEntry[] | null }>("/api/community/users/me/server-folders", communityRequestOptions(context.client, token, context.signal))
  const folders: CommunityFolder[] = data.folders.map((f) => ({
    id: f.id,
    name: f.name,
    servers: f.servers.map((s) => ({
      id: s.id,
      name: s.name,
      initial: avatarInitial(s.name),
      icon: s.icon ?? null,
    })),
  }))
  return { folders, ...(Object.hasOwn(data, "topOrder") ? { topOrder: data.topOrder } : {}) }
}

export const foldersProjectedQueryFn = (
  queryClient: QueryClient,
) => async (context: QueryFunctionContext = {} as QueryFunctionContext) => {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const data = await foldersQueryFn(context)
  publishCommunityLiveSnapshot(queryClient, {
    snapshot: { kind: "folders", data },
    proof: { kind: "structural", token, signal: context.signal },
  })
  return data.folders.map((folder) => folder.id)
}

export function useFolders(): UseQueryResult<string[]> & {
  folders: CommunityFolder[]
  topOrder?: ServerRailEntry[]
} {
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: communityKeys.folders(),
    queryFn: foldersProjectedQueryFn(queryClient),
    staleTime: 30_000,
  })
  return {
    ...query,
    topOrder: dbRail?.topOrder,
    folders: dbRail?.folders ?? (EMPTY_FOLDERS as CommunityFolder[]),
  }
}
