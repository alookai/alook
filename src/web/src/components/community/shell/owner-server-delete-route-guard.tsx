"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServers } from "@/hooks/community/use-servers"
import { communityServerId } from "@/lib/community/community-route"
import {
  consumeVoluntaryLeave,
  isOwnerServerDeleteCompleted,
  runAuthoritativeServerEject,
} from "@/lib/community/eject-server"
import { clearLastChannel } from "@/lib/community/last-channel"

/** Rechecks cached deleted-server history entries from the persistent `/c` tree. */
export function OwnerServerDeleteRouteGuard() {
  const pathname = usePathname()
  const router = useRouter()
  const currentUser = useCurrentUser()
  const servers = useServers()

  useEffect(() => {
    const serverId = communityServerId(pathname)
    if (!serverId || !isOwnerServerDeleteCompleted(serverId)) return

    runAuthoritativeServerEject({
      serverId,
      servers: servers.servers,
      isSuccess: servers.isSuccess,
      isFetching: servers.isFetching,
      consumeVoluntaryLeave,
      clearLastChannel,
      toast,
      accountId: currentUser.id,
      routeHref: pathname,
      replace: (destination) => router.replace(destination),
    })
  }, [currentUser.id, pathname, router, servers.isFetching, servers.isSuccess, servers.servers])

  return null
}
