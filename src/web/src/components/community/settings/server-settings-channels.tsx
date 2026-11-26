"use client"

import { useMemo } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { ChevronDown, Hash, Lock } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button"
import { EntityIcon } from "../entity-icon"
import { EmptyState } from "../empty-state"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import { MentionPill } from "../messages/inline-marks"
import { useServerAdminChannels, type AdminChannel } from "@/hooks/community/use-server-admin-channels"
import { tid } from "@/lib/community/testids"

const channelCreatedAtFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

type FormattedAdminChannel = AdminChannel & { createdAtLabel: string }

function groupChannels(channels: AdminChannel[]) {
  const groups = new Map<string, { name: string; private: boolean; channels: FormattedAdminChannel[] }>()
  for (const channel of channels) {
    const key = channel.category?.id ?? "__uncategorized__"
    const group = groups.get(key) ?? { name: channel.category?.name ?? "Uncategorized", private: channel.category?.private ?? false, channels: [] }
    const timestamp = new Date(channel.createdAt)
    const createdAtLabel = Number.isNaN(timestamp.getTime()) ? channel.createdAt : channelCreatedAtFormat.format(timestamp)
    group.channels.push({ ...channel, createdAtLabel })
    groups.set(key, group)
  }
  return [...groups.entries()]
}

export function ServerSettingsChannels({ serverId }: { serverId: string }) {
  const [collapsed, setCollapsed] = useAtom(useCreateAtom<Set<string>>(new Set<string>()))
  const { channels, isError, isFetching, refetch, forbidden } = useServerAdminChannels(serverId, true)
  const groupedChannels = useMemo(() => channels ? groupChannels(channels) : null, [channels])
  const retry = () => { void refetch() }
  if (forbidden) return <div role="alert" className="flex flex-1 flex-col"><EmptyState icon={Lock} label="Only server administrators can view channels." /></div>
  if (isError && !channels) return <ConversationResolutionErrorFrame as="div" title="Couldn’t load channels." retrying={isFetching} onRetry={retry} />

  return (
    <div data-testid={tid.settingsChannels} className={channels?.length === 0 ? "flex flex-1 flex-col gap-4" : "space-y-4"}>
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <p>Couldn’t refresh channels.</p>
          <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={retry} disabled={isFetching}>Retry</Button>
        </div>
      )}
      {!channels && !isError && <p role="status" className="text-sm text-muted-foreground">Loading channels…</p>}
      {channels?.length === 0 && <EmptyState icon={Hash} label="No channels yet." />}
      {groupedChannels && groupedChannels.map(([id, group]) => (
        <section key={id} aria-label={`Group: ${group.name}`} className="mb-4">
          <button
            type="button" aria-label={`Group: ${group.name}`} aria-expanded={!collapsed.has(id)}
            className="group flex min-h-11 w-full cursor-pointer touch-manipulation items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-muted-foreground/80 select-none hover:text-foreground sm:min-h-0"
            onClick={() => setCollapsed((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id); else next.add(id)
              return next
            })}
          >
            {group.private ? <Lock aria-label="Private group" className="size-3 shrink-0" /> : <span className="size-3 shrink-0" aria-hidden="true" />}
            <span className="flex-1 truncate text-left">{group.name}</span>
            <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed.has(id) ? "-rotate-90" : ""}`} />
          </button>
          {!collapsed.has(id) && <ul className="space-y-1 rounded-md">
            {group.channels.map((channel) => (
              <li key={channel.id} data-testid={tid.settingsChannel(channel.id)}>
                <div className="group relative flex min-h-8 w-full flex-wrap items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground">
                  <span className="grid size-5 shrink-0 place-items-center opacity-70"><EntityIcon kind={channel.type} className="size-4" /></span>
                  <span title={channel.name} className="min-w-0 flex-1 font-semibold wrap-anywhere">{channel.name}</span>
                  <div className="flex w-full min-w-0 items-center gap-2 pl-7 text-xs sm:w-auto sm:pl-0">
                    <span className="sr-only">Creator: </span>
                    <span className="min-w-0 flex-1 truncate sm:max-w-40 sm:flex-initial">
                      {channel.creator ? <MentionPill label={`@${channel.creator.handle}`}>@{channel.creator.handle}</MentionPill> : "Deleted user"}
                    </span>
                    <time dateTime={channel.createdAt} title={channel.createdAt} className="shrink-0 whitespace-nowrap tabular-nums">
                      <span className="sr-only">Created: </span>
                      {channel.createdAtLabel}
                    </time>
                  </div>
                </div>
              </li>
            ))}
          </ul>}
        </section>
      ))}
    </div>
  )
}
