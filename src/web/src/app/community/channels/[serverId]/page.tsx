"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useCommunity } from "@/contexts/community/context"
import { MessageList } from "@/components/community/message-list"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * /community/channels/:serverId
 *
 * Redirects to the first channel by position. Shows a channel-shell skeleton
 * while waiting for the server detail so the transition feels like a reveal
 * rather than a swap.
 */
export default function ServerDefaultPage() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const ctx = useCommunity()
  const serverId = decodeURIComponent(params.serverId)

  useEffect(() => {
    if (!ctx.currentServer) return
    const allChannels = ctx.currentServer.categories.flatMap((cat) => cat.channels)
    const first = allChannels[0]
    if (first) {
      router.replace(`/community/channels/${serverId}/${first.id}`)
    }
  }, [ctx.currentServer, serverId, router])

  const allChannels = ctx.currentServer?.categories.flatMap((cat) => cat.channels) ?? []
  if (ctx.currentServer && allChannels.length === 0) {
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
