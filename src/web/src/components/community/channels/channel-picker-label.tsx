import { ChannelIcon } from "./channel-icon"

export function ChannelPickerLabel({ name, serverName }: { name: string; serverName?: string }) {
  return (
    <>
      <span data-suggestion-icon className="inline-flex shrink-0">
        <ChannelIcon className="size-3.5 text-muted-foreground" />
      </span>
      <span data-suggestion-label className="min-w-0 flex-1 truncate font-medium">
        {serverName && <span className="text-muted-foreground">{serverName} / </span>}
        {name}
      </span>
    </>
  )
}
