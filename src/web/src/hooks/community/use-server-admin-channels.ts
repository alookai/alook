"use client"

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"

export type AdminChannel = {
  id: string
  name: string
  type: "text" | "forum"
  category: { id: string; name: string; private: boolean } | null
  creator: { name: string; handle: string } | null
  createdAt: string
}

export function useServerAdminChannels(serverId: string | null, isAdmin: boolean) {
  const enabled = Boolean(serverId && isAdmin)
  const query = useQuery({
    queryKey: communityKeys.adminChannels(enabled ? serverId! : "__none__"),
    queryFn: ({ signal }) => apiFetch<{ channels: AdminChannel[] }>(
      `/api/community/servers/${serverId}/channels/admin`,
      { signal },
    ),
    enabled,
    staleTime: 60_000,
    gcTime: 0,
    retry: false,
  })
  const forbidden = query.error instanceof ApiError && [401, 403].includes(query.error.status)
  return {
    ...query,
    channels: enabled && !forbidden ? query.data?.channels : undefined,
    forbidden,
  }
}
