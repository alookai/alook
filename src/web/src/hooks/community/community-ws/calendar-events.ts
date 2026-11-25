import { communityKeys } from "@/lib/query-keys"
import type { CommunityWsEvent } from "@alook/shared"
import type { QueryClient } from "@tanstack/react-query"

export type CalendarChangedWsEvent = Extract<
  CommunityWsEvent,
  { type: "community:calendar.changed" }
>

export function handleCalendarChanged(
  _event: CalendarChangedWsEvent,
  { queryClient }: { queryClient: QueryClient },
) {
  return queryClient.invalidateQueries({
    queryKey: communityKeys.calendar(),
    refetchType: "active",
  })
}
