"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { Loader2 } from "@/components/icons/lucide";
import { useForumPostCounts } from "@/hooks/community/use-forum-post-counts"
import { Button } from "@/components/ui/button"

const ForumPostCounts = createContext<{
  data: Record<string, number> | undefined
  failed: boolean
  fetching: boolean
  retry: () => unknown
} | undefined>(undefined)

export function ForumPostCountsProvider({ serverId, enabled, children }: { serverId: string; enabled: boolean; children: ReactNode }) {
  const { data, isError, isFetching, refetch } = useForumPostCounts(serverId, enabled)
  const value = useMemo(() => ({ data, failed: isError, fetching: isFetching, retry: refetch }), [data, isError, isFetching, refetch])
  return <ForumPostCounts value={value}>{children}</ForumPostCounts>
}

export function ForumPostCountsStatus() {
  const counts = useContext(ForumPostCounts)
  if (!counts?.failed) return null
  return <div role="alert" className="mx-2 mt-1 flex items-center gap-2 text-xs text-muted-foreground">
    <span>Could not refresh post counts.</span>
    <Button type="button" variant="ghost" size="sm" aria-label="Retry post counts" disabled={counts.fetching} onClick={() => { void counts.retry() }}>Retry</Button>
  </div>
}

export function ForumPostCount({ channelId, previewCount }: { channelId: string; previewCount?: number }) {
  const counts = useContext(ForumPostCounts)
  const count = previewCount ?? counts?.data?.[channelId]
  const unavailable = count === undefined && counts?.failed
  const label = unavailable ? "Unarchived post count unavailable" : count === undefined ? "Loading unarchived post count" : `${count.toLocaleString("en-US")} unarchived posts`
  return (
    <span className={`ml-auto flex h-5 w-[9ch] shrink-0 items-center justify-end text-xs leading-5 font-normal text-muted-foreground tabular-nums${count === 0 ? " invisible" : ""}`} title={count === 0 ? undefined : label} aria-label={count === 0 ? undefined : label} aria-hidden={count === 0 || undefined}>
      {count === 0 ? null : unavailable ? "Unknown" : count === undefined ? <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <>{count > 999 ? "999+" : count} open</>}
    </span>
  )
}
