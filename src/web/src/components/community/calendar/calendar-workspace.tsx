"use client"

import { useMemo, useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, Pause } from "@/components/icons/lucide"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { HOME_TAB_COLUMN_CLASS } from "@/components/community/home-tab-layout"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { tid } from "@/lib/community/testids"
import { CalendarActorAvatar } from "./calendar-actor"
import { CalendarAgendaView } from "./calendar-agenda-view"
import {
  addLocalDays,
  formatWeekRangeLabel,
  getWeekDays,
  startOfLocalDay,
} from "./calendar-date"
import { CalendarDetailSheet } from "./calendar-detail-sheet"
import { CalendarMobileHeader, CalendarPageSkeleton } from "./calendar-skeleton"
import { CalendarRecurrenceBadge, CalendarSourceStatusBadge } from "./calendar-status"
import type {
  CalendarActor,
  CalendarEventEditDraft,
  CalendarEventItem,
  CalendarOccurrenceItem,
  CalendarViewMode,
} from "./calendar-types"
import { CalendarWeekView } from "./calendar-week-view"

const ALL_CREATORS_VALUE = "__all__"

export function CalendarWorkspace({
  view,
  onViewChange,
  anchorDate,
  onAnchorDateChange,
  selectedCreatorId,
  onSelectedCreatorIdChange,
  creators,
  occurrences,
  pausedEvents = [],
  loading = false,
  error = null,
  retrying = false,
  onRetry,
  onBack,
  onOpenSourceMessage,
  onSaveEvent,
  onDeleteEvent,
  saving = false,
  deleting = false,
  mutationError = null,
}: {
  view: CalendarViewMode
  onViewChange: (view: CalendarViewMode) => void
  anchorDate: Date
  onAnchorDateChange: (date: Date) => void
  selectedCreatorId: string | null
  onSelectedCreatorIdChange: (creatorId: string | null) => void
  creators: readonly CalendarActor[]
  occurrences: readonly CalendarOccurrenceItem[]
  pausedEvents?: readonly CalendarEventItem[]
  loading?: boolean
  error?: string | null
  retrying?: boolean
  onRetry?: () => void
  onBack?: () => void
  onOpenSourceMessage: (messageId: string) => void
  onSaveEvent?: (eventId: string, draft: CalendarEventEditDraft) => Promise<void> | void
  onDeleteEvent?: (eventId: string) => Promise<void> | void
  saving?: boolean
  deleting?: boolean
  mutationError?: string | null
}) {
  const [datePopoverOpen, setDatePopoverOpen] = useState(false)
  const [selectedOccurrenceKey, setSelectedOccurrenceKey] = useState<string | null>(null)

  const weekDays = useMemo(() => getWeekDays(anchorDate), [anchorDate])
  const weekRangeLabel = useMemo(() => formatWeekRangeLabel(weekDays), [weekDays])

  const filteredOccurrences = useMemo(() => {
    if (!selectedCreatorId) return occurrences
    return occurrences.filter((item) => item.event.creator.id === selectedCreatorId)
  }, [occurrences, selectedCreatorId])

  const filteredPausedEvents = useMemo(() => {
    const representedEventIds = new Set(filteredOccurrences.map((item) => item.eventId))
    return pausedEvents.filter((event) => {
      if (representedEventIds.has(event.id)) return false
      if (selectedCreatorId && event.creator.id !== selectedCreatorId) return false
      return true
    })
  }, [filteredOccurrences, pausedEvents, selectedCreatorId])

  const pausedAsOccurrences = useMemo<CalendarOccurrenceItem[]>(
    () =>
      filteredPausedEvents.map((event) => ({
        occurrenceKey: `paused:${event.id}`,
        eventId: event.id,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
        runStatus: event.lastExecution?.status ?? null,
        event,
      })),
    [filteredPausedEvents],
  )

  const activeOccurrence = useMemo(() => {
    if (!selectedOccurrenceKey) return null
    return (
      filteredOccurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey)
      ?? pausedAsOccurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey)
      ?? null
    )
  }, [filteredOccurrences, pausedAsOccurrences, selectedOccurrenceKey])

  const creatorSelectItems = useMemo(
    () => [
      { value: ALL_CREATORS_VALUE, label: "All creators" },
      ...creators.map((creator) => ({
        value: creator.id,
        label: creator.kind === "human" ? `${creator.name} (Owner)` : creator.name,
      })),
    ],
    [creators],
  )

  if (loading && occurrences.length === 0 && pausedEvents.length === 0) {
    return <CalendarPageSkeleton onBack={onBack} />
  }

  return (
    <div data-testid={tid.calendarPage} className="flex min-h-0 flex-1 flex-col">
      <CalendarMobileHeader onBack={onBack} />
      <ScrollArea
        render={<section aria-labelledby="calendar-heading" />}
        className="@container flex min-h-0 flex-1 flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="flex min-h-full flex-col p-4 sm:p-8"
      >
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col gap-6 sm:gap-8`}>
          <div className="flex flex-col gap-4">
            <header className="flex flex-col gap-1 max-sm:sr-only">
              <h1 id="calendar-heading" className="text-xl font-medium text-foreground">
                Calendar
              </h1>
              <p className="text-sm text-muted-foreground">
                Shared schedule for you and your bots.
              </p>
            </header>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center rounded-md border border-border/80 bg-card p-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-10 w-10 sm:h-8 sm:w-8"
                    aria-label={view === "week" ? "Previous week" : "Previous range"}
                    onClick={() => onAnchorDateChange(addLocalDays(anchorDate, view === "week" ? -7 : -14))}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 px-3 text-xs font-medium sm:h-8"
                    onClick={() => onAnchorDateChange(startOfLocalDay(new Date()))}
                  >
                    Today
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-10 w-10 sm:h-8 sm:w-8"
                    aria-label={view === "week" ? "Next week" : "Next range"}
                    onClick={() => onAnchorDateChange(addLocalDays(anchorDate, view === "week" ? 7 : 14))}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>

                <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 gap-2 bg-card px-3 font-mono text-xs font-medium tabular-nums sm:h-9"
                      />
                    }
                  >
                    <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                    <span>{weekRangeLabel}</span>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto p-1">
                    <Calendar
                      mode="single"
                      weekStartsOn={1}
                      selected={anchorDate}
                      onSelect={(picked) => {
                        if (picked) {
                          onAnchorDateChange(startOfLocalDay(picked))
                          setDatePopoverOpen(false)
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {creators.length > 0 ? (
                  <Select
                    value={selectedCreatorId ?? ALL_CREATORS_VALUE}
                    onValueChange={(value) =>
                      onSelectedCreatorIdChange(!value || value === ALL_CREATORS_VALUE ? null : value)
                    }
                    items={creatorSelectItems}
                  >
                    <SelectTrigger
                      aria-label="Filter by creator"
                      className="h-11 min-w-36 bg-card sm:h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_CREATORS_VALUE}>All creators</SelectItem>
                      {creators.map((creator) => (
                        <SelectItem key={creator.id} value={creator.id}>
                          <span className="flex min-w-0 items-center gap-2">
                            <CalendarActorAvatar actor={creator} size={18} />
                            <span className="truncate">
                              {creator.kind === "human" ? `${creator.name} (Owner)` : creator.name}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <Tabs
                  value={view}
                  onValueChange={(next) => {
                    if (next === "week" || next === "agenda") onViewChange(next)
                  }}
                >
                  <TabsList aria-label="Calendar view" className="h-11 sm:h-9">
                    <TabsTrigger value="week" className="px-3">Week</TabsTrigger>
                    <TabsTrigger value="agenda" className="px-3">Agenda</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </div>

          {error && occurrences.length === 0 ? (
            <ConversationResolutionErrorFrame
              as="div"
              title={error}
              retrying={retrying}
              onRetry={() => onRetry?.()}
            />
          ) : view === "week" ? (
            <CalendarWeekView
              weekDays={weekDays}
              selectedDay={anchorDate}
              onSelectDay={(day) => onAnchorDateChange(startOfLocalDay(day))}
              occurrences={filteredOccurrences}
              selectedOccurrenceKey={selectedOccurrenceKey}
              onSelectOccurrence={(item) => setSelectedOccurrenceKey(item.occurrenceKey)}
            />
          ) : (
            <CalendarAgendaView
              occurrences={filteredOccurrences}
              selectedOccurrenceKey={selectedOccurrenceKey}
              onSelectOccurrence={(item) => setSelectedOccurrenceKey(item.occurrenceKey)}
            />
          )}

          {pausedAsOccurrences.length > 0 ? (
            <section aria-label="Paused schedules" className="flex flex-col gap-3 border-t border-border/60 pt-6">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Pause className="size-3.5" aria-hidden />
                <span>Paused schedules ({pausedAsOccurrences.length})</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {pausedAsOccurrences.map((item) => (
                  <button
                    key={item.occurrenceKey}
                    type="button"
                    data-testid={tid.calendarEvent(item.event.id)}
                    onClick={() => setSelectedOccurrenceKey(item.occurrenceKey)}
                    className="flex min-h-11 flex-col gap-2 rounded-lg border border-border/70 border-l-2 border-l-muted-foreground/50 bg-card/80 p-4 text-left opacity-85 transition-colors duration-150 hover:bg-accent/50 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{item.event.title}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <CalendarRecurrenceBadge recurrence={item.event.recurrence} compact />
                        <CalendarSourceStatusBadge source={item.event.sourceMessage} compact />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CalendarActorAvatar actor={item.event.creator} size={18} />
                      <span className="truncate">{item.event.creator.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </ScrollArea>

      <CalendarDetailSheet
        occurrence={activeOccurrence}
        open={Boolean(activeOccurrence)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedOccurrenceKey(null)
        }}
        onOpenSourceMessage={(messageId) => {
          setSelectedOccurrenceKey(null)
          onOpenSourceMessage(messageId)
        }}
        onSaveEvent={onSaveEvent}
        onDeleteEvent={onDeleteEvent}
        saving={saving}
        deleting={deleting}
        mutationError={mutationError}
      />
    </div>
  )
}
