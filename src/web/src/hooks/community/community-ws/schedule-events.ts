import { communityKeys } from "@/lib/query-keys"
import type { CommunityWsEvent } from "@alook/shared"
import type { QueryClient } from "@tanstack/react-query"

export type ScheduleChangedWsEvent = Extract<
  CommunityWsEvent,
  { type: "community:schedule.changed" }
>

export function handleScheduleChanged(
  _event: ScheduleChangedWsEvent,
  { queryClient }: { queryClient: QueryClient },
) {
  return queryClient.invalidateQueries({
    queryKey: communityKeys.schedule(),
    refetchType: "active",
  })
}
