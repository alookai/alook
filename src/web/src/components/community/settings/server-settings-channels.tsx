"use client"

import { Button } from "@/components/ui/button"
import { ChannelPickerLabel } from "../channels/channel-picker-label"
import { useServerAdminChannels, type AdminChannel } from "@/hooks/community/use-server-admin-channels"
import { tid } from "@/lib/community/testids"

function groupChannels(channels: AdminChannel[]) {
  const groups = new Map<string, { name: string; channels: AdminChannel[] }>()
  for (const channel of channels) {
    const key = channel.category?.id ?? "__uncategorized__"
    const group = groups.get(key) ?? { name: channel.category?.name ?? "Uncategorized", channels: [] }
    group.channels.push(channel)
    groups.set(key, group)
  }
  return [...groups.entries()]
}

export function ServerSettingsChannels({ serverId }: { serverId: string }) {
  const { channels, isError, isFetching, refetch, forbidden } = useServerAdminChannels(serverId, true)
  const retry = () => { void refetch() }
  if (forbidden) return <p role="alert" className="text-sm text-muted-foreground">Only server administrators can view channels.</p>

  return (
    <div data-testid={tid.settingsChannels} className="space-y-6">
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <p>{channels ? "Couldn’t refresh channels." : "Couldn’t load channels."}</p>
          <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={retry} disabled={isFetching}>Retry</Button>
        </div>
      )}
      {!channels && !isError && <p role="status" className="text-sm text-muted-foreground">Loading channels…</p>}
      {channels?.length === 0 && <p className="text-sm text-muted-foreground">No channels yet.</p>}
      {channels && groupChannels(channels).map(([id, group]) => (
        <section key={id} aria-label={`Group: ${group.name}`} className="space-y-2">
          <h2 className="wrap-break-word px-2 text-xs font-semibold text-muted-foreground">{group.name}</h2>
          <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-2 text-xs text-muted-foreground sm:grid" aria-hidden="true">
            <span>Channel name</span><span>Creator</span><span>Created</span>
          </div>
          <ul className="space-y-1">
            {group.channels.map((channel) => (
              <li key={channel.id} data-testid={tid.settingsChannel(channel.id)} className="grid min-w-0 gap-x-4 gap-y-1 rounded-md px-2 py-2 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 items-center gap-2" title={channel.name}><ChannelPickerLabel name={channel.name} /></div>
                <div className="min-w-0 wrap-break-word text-xs text-muted-foreground sm:text-sm">
                  <span className="sr-only">Creator: </span>
                  {channel.creator ? <span title={channel.creator.name}>@{channel.creator.handle}</span> : "Deleted user"}
                </div>
                <time dateTime={channel.createdAt} title={channel.createdAt} className="min-w-0 text-xs text-muted-foreground tabular-nums sm:text-sm">
                  <span className="sr-only">Created: </span>
                  {new Date(channel.createdAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
