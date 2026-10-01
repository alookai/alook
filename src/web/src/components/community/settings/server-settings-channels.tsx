"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ChannelCategory } from "../channels/channel-category"
import { ChannelRow } from "../channels/channel-row"
import { MentionPill } from "../messages/inline-marks"
import { useServerAdminChannels, type AdminChannel } from "@/hooks/community/use-server-admin-channels"
import { tid } from "@/lib/community/testids"

function groupChannels(channels: AdminChannel[]) {
  const groups = new Map<string, { name: string; private: boolean; channels: AdminChannel[] }>()
  for (const channel of channels) {
    const key = channel.category?.id ?? "__uncategorized__"
    const group = groups.get(key) ?? { name: channel.category?.name ?? "Uncategorized", private: channel.category?.private ?? false, channels: [] }
    group.channels.push(channel)
    groups.set(key, group)
  }
  return [...groups.entries()]
}

export function ServerSettingsChannels({ serverId }: { serverId: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const { channels, isError, isFetching, refetch, forbidden } = useServerAdminChannels(serverId, true)
  const retry = () => { void refetch() }
  if (forbidden) return <p role="alert" className="text-sm text-muted-foreground">Only server administrators can view channels.</p>

  return (
    <div data-testid={tid.settingsChannels} className="space-y-4">
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <p>{channels ? "Couldn’t refresh channels." : "Couldn’t load channels."}</p>
          <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={retry} disabled={isFetching}>Retry</Button>
        </div>
      )}
      {!channels && !isError && <p role="status" className="text-sm text-muted-foreground">Loading channels…</p>}
      {channels?.length === 0 && <p className="text-sm text-muted-foreground">No channels yet.</p>}
      {channels && groupChannels(channels).map(([id, group]) => (
        <section key={id} aria-label={`Group: ${group.name}`} className="mb-4">
          <ChannelCategory
            name={group.name} isPrivate={group.private} open={!collapsed.has(id)}
            headerProps={{ className: "min-h-11 cursor-pointer sm:min-h-0" }}
            onToggle={() => setCollapsed((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id); else next.add(id)
              return next
            })}
          >
            <ul className="space-y-1">
              {group.channels.map((channel) => (
                <li key={channel.id} data-testid={tid.settingsChannel(channel.id)}>
                  <ChannelRow name={channel.name} kind={channel.type} wrapName className="min-h-8 flex-wrap py-1 text-muted-foreground">
                    <div className="flex w-full min-w-0 items-center gap-2 pl-7 text-xs sm:w-auto sm:pl-0">
                      <span className="sr-only">Creator: </span>
                      <span className="min-w-0 flex-1 truncate sm:max-w-40 sm:flex-initial">
                        {channel.creator ? <MentionPill label={`@${channel.creator.handle}`}>@{channel.creator.handle}</MentionPill> : "Deleted user"}
                      </span>
                      <time dateTime={channel.createdAt} title={channel.createdAt} className="shrink-0 whitespace-nowrap tabular-nums">
                        <span className="sr-only">Created: </span>
                        {new Date(channel.createdAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </div>
                  </ChannelRow>
                </li>
              ))}
            </ul>
          </ChannelCategory>
        </section>
      ))}
    </div>
  )
}
