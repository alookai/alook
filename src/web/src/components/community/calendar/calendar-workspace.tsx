"use client"

import { useMemo, useState } from "react"
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Pause } from "@/components/icons/lucide"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { HOME_TAB_COLUMN_CLASS } from "@/components/community/home-tab-layout"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
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
import {
  CalendarRecurrenceBadge,
  CalendarSourceStatusBadge,
  CalendarStatusDot,
} from "./calendar-status"
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

  const jumpToToday = () => onAnchorDateChange(startOfLocalDay(new Date()))
  const stepDays = view === "week" ? 7 : 14

  if (loading && occurrences.length === 0 && pausedEvents.length === 0) {
    return <CalendarPageSkeleton onBack={onBack} />
  }

  return (
    <div data-testid={tid.calendarPage} className="flex min-h-0 flex-1 flex-col">
      <CalendarMobileHeader onBack={onBack} onToday={jumpToToday} />
      <ScrollArea
        render={<section aria-labelledby="calendar-heading" />}
        className="@container flex min-h-0 flex-1 flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="flex min-h-full flex-col p-4 sm:p-6"
      >
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col gap-5 sm:gap-6`}>
          <div className="flex flex-col gap-3 sm:gap-4">
            <header className="flex flex-col gap-0.5 max-sm:sr-only">
              <h1 id="calendar-heading" className="text-xl font-medium text-foreground">
                Calendar
              </h1>
              <p className="text-sm text-muted-foreground">
                Shared schedule for you and your bots.
              </p>
            </header>

            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="flex items-center gap-1 sm:gap-1.5">
                <button
                  type="button"
                  onClick={jumpToToday}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                    onBack ? "hidden sm:inline-flex" : "inline-flex h-10 sm:h-9",
                  )}
                >
                  Today
                </button>

                <div className="flex min-w-0 flex-1 items-center justify-between gap-1 sm:flex-none sm:justify-start sm:gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground sm:size-8"
                    aria-label={view === "week" ? "Previous week" : "Previous range"}
                    onClick={() => onAnchorDateChange(addLocalDays(anchorDate, -stepDays))}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>

                  <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2.5 text-sm font-semibold tracking-tight text-foreground transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none sm:order-3 sm:ml-1 sm:h-9 sm:flex-none sm:px-2.5 sm:text-[15px]",
                            datePopoverOpen && "bg-muted/80",
                          )}
                        />
                      }
                    >
                      <CalendarDays className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
                      <span className="truncate tabular-nums">{weekRangeLabel}</span>
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground sm:order-2 sm:size-8"
                    aria-label={view === "week" ? "Next week" : "Next range"}
                    onClick={() => onAnchorDateChange(addLocalDays(anchorDate, stepDays))}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 sm:justify-end">
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
                      className="h-10 min-w-0 flex-1 sm:h-9 sm:w-40 sm:flex-none"
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
                  className="shrink-0"
                >
                  <TabsList aria-label="Calendar view">
                    <TabsTrigger value="week">Week</TabsTrigger>
                    <TabsTrigger value="agenda">Agenda</TabsTrigger>
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
            <section aria-label="Paused schedules" className="flex flex-col gap-3 border-t border-border/60 pt-5">
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                    className="flex min-h-11 flex-col gap-2 rounded-xl border border-dashed border-border/80 bg-card/70 p-3.5 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <CalendarStatusDot paused />
                        <span className="truncate text-sm font-medium text-foreground/90">{item.event.title}</span>
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <CalendarRecurrenceBadge recurrence={item.event.recurrence} compact />
                        <CalendarSourceStatusBadge
                          source={item.event.sourceMessage}
                          runStatus={item.runStatus}
                          compact
                        />
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
