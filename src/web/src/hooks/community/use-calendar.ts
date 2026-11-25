"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import {
  calendarEventsQueryOptions,
  type CalendarEventDto,
  type CalendarUpdateRequestDto,
} from "@/lib/community/calendar"

export function useCalendarEvents(params: {
  from: string
  to: string
  enabled?: boolean
}) {
  return useQuery({
    ...calendarEventsQueryOptions({ from: params.from, to: params.to }),
    enabled: params.enabled ?? true,
  })
}

export function useUpdateCalendarEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...communityKeys.calendar(), "update"],
    mutationFn: async ({
      eventId,
      patch,
    }: {
      eventId: string
      patch: CalendarUpdateRequestDto
    }) => {
      const token = captureCommunityLiveSnapshotToken(client)
      return apiFetchCommunity<{ event: CalendarEventDto }>(
        `/api/community/calendar/events/${encodeURIComponent(eventId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
        token,
      )
    },
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: communityKeys.calendar(),
        refetchType: "active",
      })
    },
  })
}

export function useDeleteCalendarEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...communityKeys.calendar(), "delete"],
    mutationFn: async (eventId: string) => {
      const token = captureCommunityLiveSnapshotToken(client)
      return apiFetchCommunity<{ deleted: boolean }>(
        `/api/community/calendar/events/${encodeURIComponent(eventId)}`,
        {
          method: "DELETE",
        },
        token,
      )
    },
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: communityKeys.calendar(),
        refetchType: "active",
      })
    },
  })
}

export function useCalendarClockMinute(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

const INITIAL_WEEK_SCROLL_TOP_OFFSET_PX = 14

export function useInitialWeekScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  hourHeightPx: number,
  initialHour: number,
) {
  const doneRef = useRef(false)
  useEffect(() => {
    if (doneRef.current) return
    const viewport = viewportRef.current
    if (!viewport) return
    doneRef.current = true
    viewport.scrollTop = Math.max(0, initialHour * hourHeightPx - INITIAL_WEEK_SCROLL_TOP_OFFSET_PX)
  }, [hourHeightPx, initialHour, viewportRef])
}
