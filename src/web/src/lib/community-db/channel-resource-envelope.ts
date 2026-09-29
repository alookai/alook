import type { DM } from "@/lib/community/models/people"
import type {
  CategoryRow,
  ChannelMembershipRow,
  ChannelRow,
  ProfileRow,
} from "./schema"

/**
 * QueryCollection write-through locates a selected array by reference. Every
 * envelope in this shared query-key family must therefore expose every
 * projected array slot, even when a resource owns no rows for that slot.
 */
export type ChannelResourceEnvelope = {
  conversations: DM[]
  categories: CategoryRow[]
  channels: ChannelRow[]
  channelMemberships: ChannelMembershipRow[]
  profiles: ProfileRow[]
}

export function emptyChannelResourceEnvelope(): ChannelResourceEnvelope {
  return {
    conversations: [],
    categories: [],
    channels: [],
    channelMemberships: [],
    profiles: [],
  }
}
