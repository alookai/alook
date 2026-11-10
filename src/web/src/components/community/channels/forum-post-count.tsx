"use client"

import { createContext, useContext, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { useForumPostCounts } from "@/hooks/community/use-forum-post-counts"

const ForumPostCounts = createContext<Record<string, number> | undefined>(undefined)

export function ForumPostCountsProvider({ serverId, enabled, children }: { serverId: string; enabled: boolean; children: ReactNode }) {
  const { data } = useForumPostCounts(serverId, enabled)
  return <ForumPostCounts value={data}>{children}</ForumPostCounts>
}

export function ForumPostCount({ channelId, previewCount }: { channelId: string; previewCount?: number }) {
  const counts = useContext(ForumPostCounts)
  const count = previewCount ?? counts?.[channelId]
  const label = count === undefined ? "Loading unarchived post count" : `${count.toLocaleString("en-US")} unarchived posts`
  return (
    <span className={`ml-auto flex h-5 w-[9ch] shrink-0 items-center justify-end text-xs leading-5 font-normal text-muted-foreground tabular-nums${count === 0 ? " invisible" : ""}`} title={count === 0 ? undefined : label} aria-label={count === 0 ? undefined : label} aria-hidden={count === 0 || undefined}>
      {count === 0 ? null : count === undefined ? <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <>{count > 999 ? "999+" : count} open</>}
    </span>
  )
}
