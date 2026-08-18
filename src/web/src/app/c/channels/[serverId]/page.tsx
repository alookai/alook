"use client"

import { useEffect } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { MessageList } from "@/components/community/messages/message-list"
import { Skeleton } from "@/components/ui/skeleton"
import { useServer } from "@/hooks/community/use-servers"
import { useBreakpoint } from "@/hooks/use-mobile"
import { getLastChannel, pickServerLandingChannel } from "@/lib/community/last-channel"

/**
 * /c/channels/:serverId
 *
 * Restores the last channel opened in this server (per-browser memory), falling
 * back to the first channel by position. Shows a channel-shell skeleton while
 * waiting for the server detail so the transition feels like a reveal rather
 * than a swap.
 */
export default function ServerDefaultPage() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const { server: currentServer } = useServer(serverId)
  const breakpoint = useBreakpoint()

  useEffect(() => {
    if (breakpoint !== "desktop" || !currentServer) return
    const allChannels = currentServer.categories.flatMap((cat) => cat.channels)
    // Restore the remembered route leaf, including canonical parent/child
    // leaves, or use the first top-level channel when there is no memory.
    const target = pickServerLandingChannel(
      allChannels.map((c) => c.id),
      getLastChannel(serverId),
    )
    if (target) {
      const search = searchParams.toString()
      router.replace(`/c/channels/${serverId}/${target}${search ? `?${search}` : ""}`)
    }
  }, [breakpoint, currentServer, serverId, router, searchParams])

  if (breakpoint !== "desktop") return null

  const allChannels = currentServer?.categories.flatMap((cat) => cat.channels) ?? []
  if (currentServer && allChannels.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-sm">No channels yet</span>
        <span className="text-xs">Create a channel from the sidebar to get started.</span>
      </div>
    )
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <Skeleton className="size-4 rounded" />
        <Skeleton className="h-4 w-40 rounded" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList channel="" messages={[]} loading onOpenThread={() => {}} />
        <div className="px-3 pb-3 pt-0">
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      </main>
    </>
  )
}
