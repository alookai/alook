import { communityKeys } from "@/lib/query-keys"
import type { QueryClient } from "@tanstack/react-query"

export type CalendarChangedWsEvent = {
  type: "community:calendar.changed"
  eventId: string
  reason: "created" | "updated" | "deleted" | "run_updated"
}

export function handleCalendarChanged(
  _event: CalendarChangedWsEvent,
  { queryClient }: { queryClient: QueryClient },
) {
  return queryClient.invalidateQueries({
    queryKey: communityKeys.calendar(),
    refetchType: "active",
  })
}
