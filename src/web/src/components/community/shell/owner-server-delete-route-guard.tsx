"use client"

import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServers } from "@/hooks/community/use-servers"
import { communityServerId } from "@/lib/community/community-route"
import {
  consumeVoluntaryLeave,
  runAuthoritativeServerEject,
} from "@/lib/community/eject-server"
import { clearLastChannel } from "@/lib/community/last-channel"

/** Rechecks cached deleted-server history entries from the persistent `/c` tree. */
export function OwnerServerDeleteRouteGuard() {
  const pathname = usePathname()
  const router = useRouter()
  const currentUser = useCurrentUser()
  const queryClient = useQueryClient()
  const list = useServers()
  const serverId = communityServerId(pathname)
  const completed = useSelector(getCommunityRuntime(queryClient).serverEject, (state) => !!serverId && state.flushedServerIds.has(serverId))

  useEffect(() => {
    if (!serverId || !completed) return

    runAuthoritativeServerEject({
      serverId, servers: list.servers, isSuccess: list.isSuccess, isFetching: list.isFetching,
      consumeVoluntaryLeave: (id) => consumeVoluntaryLeave(queryClient, id), clearLastChannel, toast, accountId: currentUser.id, routeHref: pathname,
      replace: (destination) => router.replace(destination),
    })
  }, [completed, currentUser.id, pathname, queryClient, router, serverId, list.servers, list.isSuccess, list.isFetching])

  return null
}
