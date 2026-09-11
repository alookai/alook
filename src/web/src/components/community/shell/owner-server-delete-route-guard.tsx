"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useCurrentUser } from "@/contexts/community/current-user"
import type { ServersResponse } from "@/hooks/community/use-servers"
import { communityServerId } from "@/lib/community/community-route"
import {
  consumeVoluntaryLeave,
  isOwnerServerDeleteCompleted,
  runAuthoritativeServerEject,
} from "@/lib/community/eject-server"
import { clearLastChannel } from "@/lib/community/last-channel"
import { communityKeys } from "@/lib/query-keys"

/** Rechecks cached deleted-server history entries from the persistent `/c` tree. */
export function OwnerServerDeleteRouteGuard() {
  const pathname = usePathname()
  const router = useRouter()
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()

  useEffect(() => {
    const serverId = communityServerId(pathname)
    if (!serverId || !isOwnerServerDeleteCompleted(serverId)) return

    const eject = () => {
      const key = communityKeys.servers()
      const state = queryClient.getQueryState(key)
      const servers = queryClient.getQueryData<ServersResponse>(key)?.servers ?? []
      return runAuthoritativeServerEject({
        serverId,
        servers,
        isSuccess: state?.status === "success",
        isFetching: state?.fetchStatus === "fetching",
        consumeVoluntaryLeave,
        clearLastChannel,
        toast,
        accountId: currentUser.id,
        routeHref: pathname,
        replace: (destination) => router.replace(destination),
      })
    }

    if (eject()) return
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== queryClient.getQueryCache().find({
        queryKey: communityKeys.servers(),
        exact: true,
      })?.queryHash) return
      if (eject()) unsubscribe()
    })
    return unsubscribe
  }, [currentUser.id, pathname, queryClient, router])

  return null
}
