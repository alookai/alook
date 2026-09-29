"use client"

import {
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import type { CommunityFolder } from "@/lib/community/models/navigation"
import {
  useOptionalCommunityDbRegistry,
  useServerRailProjection,
} from "@/lib/community-db/projections"
import {
  createFoldersResourceQueryFn,
  foldersResourceKey,
  type FoldersResource,
} from "@/lib/community-db/folders-resource"

/**
 * Fetches the user's server-folder groupings for the rail.
 *
 * The API returns raw folder rows; we materialise the `FolderServer` view
 * shape (with `initial`) here so consumers get render-ready data. The
 * transform is deterministic per row so it's safe inside the query function.
 */
export type FoldersResponse = { folders: CommunityFolder[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_FOLDERS: readonly CommunityFolder[] = Object.freeze([])

export const foldersQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<FoldersResponse> => {
  return createFoldersResourceQueryFn(context.client, "anon")(context)
}

export function useFolders(): UseQueryResult<FoldersResponse> & {
  folders: CommunityFolder[]
} {
  const registry = useOptionalCommunityDbRegistry()
  const dbRail = useServerRailProjection()
  const queryClient = useQueryClient()
  const scopeId = registry?.scopeId ?? "anon"
  const query = useQuery({
    queryKey: foldersResourceKey(scopeId),
    queryFn: createFoldersResourceQueryFn(queryClient, scopeId),
  })
  return {
    ...query,
    folders: registry
      ? dbRail?.folders ?? (EMPTY_FOLDERS as CommunityFolder[])
      : query.data?.folders ?? (EMPTY_FOLDERS as CommunityFolder[]),
  } as UseQueryResult<FoldersResource> & { folders: CommunityFolder[] }
}
