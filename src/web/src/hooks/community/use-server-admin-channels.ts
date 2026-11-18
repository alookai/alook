"use client"

import { useLayoutEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { fetchBotDirectory } from "@/lib/community/bot-directory-read"
import { retireBotDirectoryScopes } from "@/lib/community/bot-directory-lifecycle"
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
  const client = useQueryClient()
  const enabled = Boolean(serverId && isAdmin)
  useLayoutEffect(() => {
    const registry = getCommunityDbRegistry(client)
    if (registry && serverId && !isAdmin) void retireBotDirectoryScopes(registry, [{ kind: "server-admin", id: serverId }]).catch(error => console.error("Admin directory retirement failed", error))
  }, [client, serverId, isAdmin])
  const query = useQuery({
    queryKey: communityKeys.adminChannels(enabled ? serverId! : "__none__"),
    queryFn: context => fetchBotDirectory<{ channels: AdminChannel[] }>(context, `/api/community/servers/${serverId}/channels/admin`),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
  const forbidden = query.error instanceof ApiError && [401, 403].includes(query.error.status)
  return {
    ...query,
    channels: enabled && !forbidden ? query.data?.channels : undefined,
    forbidden,
  }
}
