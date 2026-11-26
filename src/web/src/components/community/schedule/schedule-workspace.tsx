"use client"

import { useMemo, useState } from "react"
import { Bot, ChevronDown, ChevronLeft, ChevronRight } from "@/components/icons/lucide"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ScheduleActorAvatar } from "./schedule-actor"
import { ScheduleAgendaView } from "./schedule-agenda-view"
import { ScheduleBotNotice } from "./schedule-bot-notice"
import {
  addLocalDays,
  formatMonthHeadingParts,
  getWeekDays,
  startOfLocalDay,
} from "./schedule-date"
import { ScheduleDetailSheet } from "./schedule-detail-sheet"
import { SchedulePageSkeleton } from "./schedule-skeleton"
import type {
  ScheduleActor,
  ScheduleOccurrenceItem,
  ScheduleViewMode,
} from "./schedule-types"
import { ScheduleWeekView } from "./schedule-week-view"
import styles from "./schedule.module.css"

const ALL_BOTS_VALUE = "__all__"

export function ScheduleWorkspace({
  view,
  onViewChange,
  anchorDate,
  onAnchorDateChange,
  selectedBotId,
  onSelectedBotIdChange,
  bots,
  occurrences,
  loading = false,
  error = null,
  retrying = false,
  onRetry,
  onBack,
  onOpenSourceMessage,
  onAskBot,
  askingBot = false,
  onOpenBots,
}: {
  view: ScheduleViewMode
  onViewChange: (view: ScheduleViewMode) => void
  anchorDate: Date
  onAnchorDateChange: (date: Date) => void
  selectedBotId: string | null
  onSelectedBotIdChange: (botId: string | null) => void
  bots: readonly ScheduleActor[]
  occurrences: readonly ScheduleOccurrenceItem[]
  loading?: boolean
  error?: string | null
  retrying?: boolean
  onRetry?: () => void
  onBack?: () => void
  onOpenSourceMessage: (messageId: string) => void
  onAskBot?: (botId: string) => void
  askingBot?: boolean
  onOpenBots?: () => void
}) {
  const [datePopoverOpen, setDatePopoverOpen] = useState(false)
  const [selectedOccurrenceKey, setSelectedOccurrenceKey] = useState<string | null>(null)

  const weekDays = useMemo(() => getWeekDays(anchorDate), [anchorDate])
  const headingParts = useMemo(
    () => formatMonthHeadingParts(weekDays, anchorDate),
    [weekDays, anchorDate],
  )

  const filteredOccurrences = useMemo(() => {
    if (!selectedBotId) return occurrences
    return occurrences.filter((item) => item.event.creator.id === selectedBotId)
  }, [occurrences, selectedBotId])

  const activeOccurrence = useMemo(() => {
    if (!selectedOccurrenceKey) return null
    return filteredOccurrences.find((item) => item.occurrenceKey === selectedOccurrenceKey) ?? null
  }, [filteredOccurrences, selectedOccurrenceKey])

  const selectedBot = useMemo(
    () => (selectedBotId ? bots.find((b) => b.id === selectedBotId) ?? null : null),
    [bots, selectedBotId],
  )

  const botSelectItems = useMemo(
    () => [
      { value: ALL_BOTS_VALUE, label: "All bots" },
      ...bots.map((bot) => ({
        value: bot.id,
        label: bot.name,
      })),
    ],
    [bots],
  )

  const jumpToToday = () => onAnchorDateChange(startOfLocalDay(new Date()))
  const stepDays = view === "week" ? 7 : 14
  const taskCountLabel = filteredOccurrences.length === 0
    ? "No tasks"
    : filteredOccurrences.length === 1
      ? "1 task"
      : `${filteredOccurrences.length} tasks`

  if (loading && occurrences.length === 0) {
    return <SchedulePageSkeleton onBack={onBack} />
  }

  return (
    <section
      aria-labelledby="schedule-heading"
      data-testid={tid.schedulePage}
      className="@container flex min-h-0 flex-1 flex-col bg-background"
    >
      <h1 id="schedule-heading" className="sr-only">
        Schedule
      </h1>

      <header className="shrink-0 border-b border-border/55 bg-background px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
            <div className="flex min-w-0 items-center gap-1">
              {onBack ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2.5 size-11 shrink-0 text-muted-foreground hover:text-foreground sm:hidden"
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
                  <span className="truncate text-lg leading-tight font-semibold tracking-tight text-foreground sm:text-xl">
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

            <div className="hidden items-center gap-1.5 font-mono text-[11px] leading-none tabular-nums text-muted-foreground sm:flex">
              <span>{headingParts.rangeShort}</span>
              <span aria-hidden className="text-border">·</span>
              <span>{taskCountLabel}</span>
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

            {bots.length > 0 ? (
              <Select
                value={selectedBotId ?? ALL_BOTS_VALUE}
                onValueChange={(value) =>
                  onSelectedBotIdChange(!value || value === ALL_BOTS_VALUE ? null : value)
                }
                items={botSelectItems}
              >
                <SelectTrigger
                  aria-label="Filter by bot"
                  className={cn(styles.filterPill, "min-w-0 flex-1 sm:w-38 sm:flex-none")}
                >
                  <SelectValue>
                    {selectedBot ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ScheduleActorAvatar actor={selectedBot} size={18} />
                        <span className="truncate">{selectedBot.name}</span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5 text-foreground/85">
                        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">All bots</span>
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BOTS_VALUE}>All bots</SelectItem>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <ScheduleActorAvatar actor={bot} size={18} />
                        <span className="truncate">{bot.name}</span>
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
              <TabsList aria-label="Schedule view">
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="agenda">Agenda</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <ScheduleBotNotice
        bots={bots}
        selectedBot={selectedBot}
        onAskBot={onAskBot}
        askingBot={askingBot}
        onOpenBots={onOpenBots}
      />

      {error && occurrences.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ConversationResolutionErrorFrame
            as="div"
            title={error}
            retrying={retrying}
            onRetry={() => onRetry?.()}
          />
        </div>
      ) : view === "week" ? (
        <ScheduleWeekView
          weekDays={weekDays}
          selectedDay={anchorDate}
          onSelectDay={(day) => onAnchorDateChange(startOfLocalDay(day))}
          occurrences={filteredOccurrences}
          selectedOccurrenceKey={selectedOccurrenceKey}
          onSelectOccurrence={(item) => setSelectedOccurrenceKey(item.occurrenceKey)}
          onOpenSourceMessage={onOpenSourceMessage}
        />
      ) : (
        <ScheduleAgendaView
          occurrences={filteredOccurrences}
          selectedOccurrenceKey={selectedOccurrenceKey}
          onSelectOccurrence={(item) => setSelectedOccurrenceKey(item.occurrenceKey)}
          onOpenSourceMessage={onOpenSourceMessage}
        />
      )}

      <ScheduleDetailSheet
        occurrence={activeOccurrence}
        open={Boolean(activeOccurrence)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedOccurrenceKey(null)
        }}
        onOpenSourceMessage={(messageId) => {
          setSelectedOccurrenceKey(null)
          onOpenSourceMessage(messageId)
        }}
      />
    </section>
  )
}
