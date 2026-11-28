"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { scheduleEventsQueryOptions } from "@/lib/community/schedule"

const SCHEDULE_STALE_TIME_MS = 30_000

export function useScheduleEvents(params: {
  from: string
  to: string
  enabled?: boolean
}) {
  return useQuery({
    ...scheduleEventsQueryOptions({ from: params.from, to: params.to }),
    placeholderData: keepPreviousData,
    staleTime: SCHEDULE_STALE_TIME_MS,
    enabled: params.enabled ?? true,
  })
}

export function usePrefetchAdjacentScheduleRanges(params: {
  prevFrom: string
  prevTo: string
  nextFrom: string
  nextTo: string
  enabled?: boolean
}) {
  const queryClient = useQueryClient()
  const { prevFrom, prevTo, nextFrom, nextTo, enabled = true } = params
  useEffect(() => {
    if (!enabled) return
    void queryClient
      .query({
        ...scheduleEventsQueryOptions({ from: prevFrom, to: prevTo }),
        staleTime: SCHEDULE_STALE_TIME_MS,
      })
      .catch(() => undefined)
    void queryClient
      .query({
        ...scheduleEventsQueryOptions({ from: nextFrom, to: nextTo }),
        staleTime: SCHEDULE_STALE_TIME_MS,
      })
      .catch(() => undefined)
  }, [enabled, nextFrom, nextTo, prevFrom, prevTo, queryClient])
}

export function useScheduleClockMinute(): Date {
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
