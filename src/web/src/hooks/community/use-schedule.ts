"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import { scheduleEventsQueryOptions } from "@/lib/community/schedule"

export function useScheduleEvents(params: {
  from: string
  to: string
  enabled?: boolean
}) {
  return useQuery({
    ...scheduleEventsQueryOptions({ from: params.from, to: params.to }),
    enabled: params.enabled ?? true,
  })
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
