"use client"

import { useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, Users } from "@/components/icons/lucide"
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
  formatMonthHeadingParts,
  getWeekDays,
  startOfLocalDay,
} from "./calendar-date"
import { CalendarDetailSheet } from "./calendar-detail-sheet"
import { CalendarPageSkeleton } from "./calendar-skeleton"
import type {
  CalendarActor,
  CalendarEventEditDraft,
  CalendarOccurrenceItem,
  CalendarViewMode,
} from "./calendar-types"
import { CalendarWeekView } from "./calendar-week-view"
import styles from "./calendar.module.css"

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
  const headingParts = useMemo(
    () => formatMonthHeadingParts(weekDays, anchorDate),
    [weekDays, anchorDate],
  )

  const filteredOccurrences = useMemo(() => {
    if (!selectedCreatorId) return occurrences
    return occurrences.filter((item) => item.event.creator.id === selectedCreatorId)
  }, [occurrences, selectedCreatorId])

  const activeOccurrence = useMemo(() => {
    if (!selectedOccurrenceKey) return null
    return filteredOccurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey) ?? null
  }, [filteredOccurrences, selectedOccurrenceKey])

  const selectedCreator = useMemo(
    () => (selectedCreatorId ? creators.find((c) => c.id === selectedCreatorId) ?? null : null),
    [creators, selectedCreatorId],
  )

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
  const eventCountLabel = filteredOccurrences.length === 0
    ? "No events"
    : filteredOccurrences.length === 1
      ? "1 event"
      : `${filteredOccurrences.length} events`

  if (loading && occurrences.length === 0) {
    return <CalendarPageSkeleton onBack={onBack} />
  }

  return (
    <div data-testid={tid.calendarPage} className="flex min-h-0 flex-1 flex-col">
      <ScrollArea
        render={<section aria-labelledby="calendar-heading" />}
        className="@container flex min-h-0 flex-1 flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="flex min-h-full flex-col px-4 pt-3 pb-6 sm:p-6"
      >
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col gap-4 sm:gap-5`}>
          <h1 id="calendar-heading" className="sr-only">
            Calendar
          </h1>

          <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-1">
              <div className="flex min-w-0 items-center gap-1">
                {onBack ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="-ml-2 size-10 shrink-0 text-muted-foreground hover:text-foreground sm:hidden"
                    aria-label="Back"
                    onClick={onBack}
                  >
                    <ChevronLeft className="size-5" />
                  </Button>
                ) : null}

                <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        data-open={datePopoverOpen || undefined}
                        aria-label={`Jump to date, ${headingParts.month} ${headingParts.year}`}
                        className={cn(
                          styles.monthTrigger,
                          "min-w-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        )}
                      />
                    }
                  >
                    <span className="truncate text-lg font-semibold tracking-tight text-foreground sm:text-2xl">
                      <span className="sm:hidden">{headingParts.monthShort}</span>
                      <span className="hidden sm:inline">{headingParts.month}</span>
                      <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                        {headingParts.year}
                      </span>
                    </span>
                    <span className={styles.monthChevron} aria-hidden>
                      <ChevronDown className="size-3.5" />
                    </span>
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

              <div className="hidden items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground sm:flex">
                <span>{headingParts.rangeShort}</span>
                <span aria-hidden className="text-border">·</span>
                <span>{eventCountLabel}</span>
              </div>

              <div className={cn(styles.navTray, "inline-flex shrink-0 sm:hidden")}>
                <button
                  type="button"
                  className={styles.navStep}
                  aria-label={view === "week" ? "Previous week" : "Previous range"}
                  onClick={() => onAnchorDateChange(addLocalDays(anchorDate, -stepDays))}
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  className={styles.todayKey}
                  onClick={jumpToToday}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={styles.navStep}
                  aria-label={view === "week" ? "Next week" : "Next range"}
                  onClick={() => onAnchorDateChange(addLocalDays(anchorDate, stepDays))}
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <div className={cn(styles.navTray, "hidden shrink-0 sm:inline-flex")}>
                <button
                  type="button"
                  className={styles.navStep}
                  aria-label={view === "week" ? "Previous week" : "Previous range"}
                  onClick={() => onAnchorDateChange(addLocalDays(anchorDate, -stepDays))}
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  className={styles.todayKey}
                  onClick={jumpToToday}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={styles.navStep}
                  aria-label={view === "week" ? "Next week" : "Next range"}
                  onClick={() => onAnchorDateChange(addLocalDays(anchorDate, stepDays))}
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>

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
                    className={cn(styles.filterPill, "min-w-0 flex-1 sm:w-38 sm:flex-none")}
                  >
                    <SelectValue>
                      {selectedCreator ? (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <CalendarActorAvatar actor={selectedCreator} size={18} />
                          <span className="truncate">{selectedCreator.name}</span>
                        </span>
                      ) : (
                        <span className="flex min-w-0 items-center gap-1.5 text-foreground/85">
                          <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">All creators</span>
                        </span>
                      )}
                    </SelectValue>
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
          </header>

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
