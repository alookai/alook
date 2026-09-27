"use client"

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityFolder } from "@/lib/community/models/navigation"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  useOptionalCommunityDbRegistry,
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
  position: number
  servers: Array<{ id: string; name: string; icon?: string | null }>
}

export type FoldersResponse = { folders: CommunityFolder[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_FOLDERS: readonly CommunityFolder[] = Object.freeze([])

export const foldersQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<FoldersResponse> => {
  const before = useCommunityWsStore.getState()
  const token = {
    viewerId: before.profileViewerId,
    accountEpoch: before.profileAccountEpoch,
    accessEpoch: before.accessEpoch,
  }
  const data = context.signal
    ? await apiFetch<{ folders: RawFolder[] }>(
        "/api/community/users/me/server-folders",
        { signal: context.signal },
      )
    : await apiFetch<{ folders: RawFolder[] }>("/api/community/users/me/server-folders")
  const after = useCommunityWsStore.getState()
  if (
    after.profileViewerId !== token.viewerId
    || after.profileAccountEpoch !== token.accountEpoch
    || after.accessEpoch !== token.accessEpoch
  ) throw new DOMException("Stale structural query", "AbortError")
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

export const foldersProjectedQueryFn = (
  queryClient: QueryClient,
) => async (context: QueryFunctionContext = {} as QueryFunctionContext) => {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const data = await foldersQueryFn(context)
  publishCommunityLiveSnapshot(queryClient, {
    snapshot: { kind: "folders", data },
    proof: { kind: "structural", token, signal: context.signal },
  })
  return data
}

export function useFolders(): UseQueryResult<FoldersResponse> & {
  folders: CommunityFolder[]
} {
  const registry = useOptionalCommunityDbRegistry()
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: communityKeys.folders(),
    queryFn: foldersProjectedQueryFn(queryClient),
  })
  return {
    ...query,
    folders: registry
      ? dbRail?.folders ?? (EMPTY_FOLDERS as CommunityFolder[])
      : query.data?.folders ?? (EMPTY_FOLDERS as CommunityFolder[]),
  }
}
