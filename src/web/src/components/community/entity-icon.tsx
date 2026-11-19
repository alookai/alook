import { Hash, ListChevronsUpDown } from "@/components/icons/lucide";
import { ChannelIcon } from "./channels/channel-icon"
import type { EntityKind } from "@/lib/community/models/navigation"

export function EntityIcon({ kind, className }: { kind: EntityKind | undefined; className?: string }) {
  switch (kind) {
    case "forum":
      return <ListChevronsUpDown className={className} />
    case "thread":
      return <Hash className={className} />
    default:
      return <ChannelIcon className={className} />
  }
}
