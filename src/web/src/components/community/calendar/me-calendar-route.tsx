"use client"

import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useCommunityModuleLocation } from "@/contexts/community/module-route"
import { useBots } from "@/hooks/community/use-bots"
import {
  useCalendarEvents,
  useDeleteCalendarEvent,
  useUpdateCalendarEvent,
} from "@/hooks/community/use-calendar"
import { mapCalendarListResponse } from "@/lib/community/calendar"
import { useUiHandlers } from "@/stores/community"
import {
  getAgendaQueryRange,
  getWeekQueryRange,
  startOfLocalDay,
} from "./calendar-date"
import type {
  CalendarActor,
  CalendarEventEditDraft,
  CalendarViewMode,
} from "./calendar-types"
import { CalendarWorkspace } from "./calendar-workspace"

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

export default function MeCalendarPage() {
  const handlers = useUiHandlers()
  const currentUser = useCurrentUser()
  const { router } = useCommunityModuleLocation()
  const bots = useBots()

  const [view, setView] = useState<CalendarViewMode>("week")
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfLocalDay(new Date()))
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const queryRange = useMemo(
    () => (view === "week" ? getWeekQueryRange(anchorDate) : getAgendaQueryRange(anchorDate, 30)),
    [anchorDate, view],
  )

  const calendarQuery = useCalendarEvents(queryRange)
  const updateMutation = useUpdateCalendarEvent()
  const deleteMutation = useDeleteCalendarEvent()

  const avatarByUserId = useMemo(() => {
    const map = new Map<string, string | null>()
    map.set(currentUser.id, currentUser.avatar ?? null)
    for (const bot of bots.bots) {
      map.set(bot.id, bot.image ?? null)
    }
    return map
  }, [bots.bots, currentUser.avatar, currentUser.id])

  const mapped = useMemo(
    () =>
      calendarQuery.data
        ? mapCalendarListResponse(calendarQuery.data, avatarByUserId)
        : null,
    [avatarByUserId, calendarQuery.data],
  )

  const creators = useMemo<CalendarActor[]>(() => {
    if (mapped && mapped.creators.length > 0) return mapped.creators
    return bots.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      kind: "bot",
      avatarUrl: bot.image,
    }))
  }, [bots.bots, mapped])

  const handleOpenSourceMessage = useCallback(
    (messageId: string) => {
      handlers.cancelPendingNavigation?.()
      router.push(`/c/messages/${encodeURIComponent(messageId)}`)
    },
    [handlers, router],
  )

  const handleSaveEvent = useCallback(
    async (eventId: string, draft: CalendarEventEditDraft) => {
      setMutationError(null)
      try {
        await updateMutation.mutateAsync({
          eventId,
          patch: {
            title: draft.title,
            description: draft.description,
            startAt: draft.startAt,
            durationMinutes: draft.durationMinutes,
            timeZone: draft.timeZone,
            recurrence: draft.recurrence,
            paused: draft.paused,
          },
        })
        toast.success("Event updated")
      } catch (error) {
        const message = formatErrorMessage(error, "Couldn’t save changes — check your connection and retry.")
        setMutationError(message)
        toast.error(message)
        throw error
      }
    },
    [updateMutation],
  )

  const handleDeleteEvent = useCallback(
    async (eventId: string) => {
      setMutationError(null)
      try {
        await deleteMutation.mutateAsync(eventId)
        toast.success("Event deleted")
      } catch (error) {
        const message = formatErrorMessage(error, "Couldn’t delete event — check your connection and retry.")
        setMutationError(message)
        toast.error(message)
        throw error
      }
    },
    [deleteMutation],
  )

  const loadError = calendarQuery.isError && !calendarQuery.data
    ? "Couldn’t load your calendar — check your connection and retry."
    : null

  return (
    <CalendarWorkspace
      view={view}
      onViewChange={setView}
      anchorDate={anchorDate}
      onAnchorDateChange={setAnchorDate}
      selectedCreatorId={selectedCreatorId}
      onSelectedCreatorIdChange={setSelectedCreatorId}
      creators={creators}
      occurrences={mapped?.occurrences ?? []}
      pausedEvents={mapped?.pausedEvents ?? []}
      loading={calendarQuery.isPending}
      error={loadError}
      retrying={calendarQuery.isFetching}
      onRetry={() => {
        void calendarQuery.refetch()
      }}
      onBack={() => handlers.goBackMobile?.()}
      onOpenSourceMessage={handleOpenSourceMessage}
      onSaveEvent={handleSaveEvent}
      onDeleteEvent={handleDeleteEvent}
      saving={updateMutation.isPending}
      deleting={deleteMutation.isPending}
      mutationError={mutationError}
    />
  )
}
