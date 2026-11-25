"use client"

import { useState, type SyntheticEvent } from "react"
import {
  CalendarDays,
  ExternalLink,
  Pencil,
  Trash2,
  TriangleAlertIcon,
} from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { CalendarActorAvatar } from "./calendar-actor"
import {
  combineLocalDateAndTime,
  DEFAULT_OCCURRENCE_DURATION_MINUTES,
  formatTimeInputValue,
  formatTimeRange,
} from "./calendar-date"
import {
  CalendarRecurrenceBadge,
  CalendarRunStatusBadge,
  CalendarSourceStatusBadge,
} from "./calendar-status"
import type {
  CalendarEventEditDraft,
  CalendarOccurrenceItem,
  CalendarRecurrenceFreq,
  CalendarRecurrenceRule,
} from "./calendar-types"

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120] as const
const WEEKDAY_CHOICES = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const

type RecurrenceOption = "none" | CalendarRecurrenceFreq

function formatFullDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function formatDateOnly(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

function formatDateButtonLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

export function CalendarDetailSheet({
  occurrence,
  open,
  onOpenChange,
  onOpenSourceMessage,
  onSaveEvent,
  onDeleteEvent,
  saving = false,
  deleting = false,
  mutationError = null,
}: {
  occurrence: CalendarOccurrenceItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenSourceMessage: (messageId: string) => void
  onSaveEvent?: (eventId: string, draft: CalendarEventEditDraft) => Promise<void> | void
  onDeleteEvent?: (eventId: string) => Promise<void> | void
  saving?: boolean
  deleting?: boolean
  mutationError?: string | null
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [startDate, setStartDate] = useState<Date>(() => new Date())
  const [startTime, setStartTime] = useState("09:00")
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_OCCURRENCE_DURATION_MINUTES)
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceOption>("none")
  const [recurrenceInterval, setRecurrenceInterval] = useState(1)
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([])
  const [paused, setPaused] = useState(false)

  const event = occurrence?.event ?? null
  const runStatus = occurrence?.runStatus ?? event?.lastExecution?.status ?? null

  function beginEditing() {
    if (!event) return
    const parsedStart = new Date(event.startAt)
    const validStart = Number.isNaN(parsedStart.getTime()) ? new Date() : parsedStart
    const rule = event.recurrence.rule ?? null

    setTitle(event.title)
    setDescription(event.description ?? "")
    setStartDate(validStart)
    setStartTime(formatTimeInputValue(validStart))
    setDurationMinutes(event.durationMinutes || DEFAULT_OCCURRENCE_DURATION_MINUTES)
    setRecurrenceFreq(rule ? rule.freq : "none")
    setRecurrenceInterval(rule ? Math.max(1, rule.interval) : 1)
    setRecurrenceWeekdays(rule?.freq === "weekly" ? (rule.byWeekday ?? [validStart.getDay()]) : [])
    setPaused(Boolean(event.paused))
    setEditing(true)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setEditing(false)
      setConfirmDeleteOpen(false)
      setDatePickerOpen(false)
    }
    onOpenChange(nextOpen)
  }

  function toggleWeekday(day: number) {
    setRecurrenceWeekdays((current) => {
      if (current.includes(day)) {
        return current.length > 1 ? current.filter((d) => d !== day) : current
      }
      return [...current, day].sort((a, b) => a - b)
    })
  }

  async function handleSave(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!event || !onSaveEvent || !title.trim()) return
    const combined = combineLocalDateAndTime(startDate, startTime)
    let recurrence: CalendarRecurrenceRule | null = null
    if (recurrenceFreq !== "none") {
      recurrence = {
        freq: recurrenceFreq,
        interval: Math.max(1, Math.min(365, recurrenceInterval || 1)),
        ...(recurrenceFreq === "weekly" && recurrenceWeekdays.length > 0
          ? { byWeekday: recurrenceWeekdays }
          : {}),
        ...(event.recurrence.rule?.untilAt ? { untilAt: event.recurrence.rule.untilAt } : {}),
        ...(event.recurrence.rule?.count ? { count: event.recurrence.rule.count } : {}),
      }
    }
    await onSaveEvent(event.id, {
      title: title.trim(),
      description: description.trim(),
      startAt: combined.toISOString(),
      durationMinutes,
      timeZone: event.timeZone,
      recurrence,
      paused,
    })
    setEditing(false)
  }

  async function handleDeleteConfirm() {
    if (!event || !onDeleteEvent) return
    await onDeleteEvent(event.id)
    setConfirmDeleteOpen(false)
    handleOpenChange(false)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          data-testid={tid.calendarDetailSheet}
          className="sm:max-w-lg"
        >
          {event && occurrence ? (
            <>
              <SheetHeader className="pr-12">
                <div className="flex flex-wrap items-center gap-1.5">
                  <CalendarRecurrenceBadge recurrence={event.recurrence} />
                  <CalendarSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} />
                  <CalendarRunStatusBadge status={runStatus} paused={event.paused} />
                </div>
                <SheetTitle className="mt-1">
                  {editing ? "Edit event" : event.title}
                </SheetTitle>
                <SheetDescription className="font-mono text-xs tabular-nums">
                  {formatDateOnly(occurrence.startAt)} · {formatTimeRange(occurrence.startAt, occurrence.endAt)}
                  {event.timeZone ? ` · ${event.timeZone}` : ""}
                </SheetDescription>
              </SheetHeader>

              <SheetBody>
                {editing ? (
                  <form id="calendar-event-edit-form" onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="calendar-edit-title">Title</Label>
                      <Input
                        id="calendar-edit-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        required
                        maxLength={160}
                        className="h-11 sm:h-9"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="flex flex-col gap-2">
                        <Label>Date</Label>
                        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                          <PopoverTrigger
                            render={
                              <button
                                type="button"
                                className="flex h-11 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-9"
                              />
                            }
                          >
                            <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate font-mono text-xs tabular-nums text-foreground">
                              {formatDateButtonLabel(startDate)}
                            </span>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-auto p-1">
                            <Calendar
                              mode="single"
                              weekStartsOn={1}
                              selected={startDate}
                              onSelect={(picked) => {
                                if (picked) {
                                  setStartDate(picked)
                                  setDatePickerOpen(false)
                                }
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      </div>

                      <div className="flex flex-col gap-2">
                        <Label htmlFor="calendar-edit-time">Time</Label>
                        <Input
                          id="calendar-edit-time"
                          type="time"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                          required
                          className="h-11 font-mono tabular-nums sm:h-9"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="calendar-edit-duration">Duration</Label>
                        <Select
                          value={String(durationMinutes)}
                          onValueChange={(val) => {
                            if (val) setDurationMinutes(Number(val))
                          }}
                          items={DURATION_OPTIONS.map((m) => ({ value: String(m), label: `${m} min` }))}
                        >
                          <SelectTrigger id="calendar-edit-duration" className="h-11 w-full sm:h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DURATION_OPTIONS.map((m) => (
                              <SelectItem key={m} value={String(m)}>
                                {m} min
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex flex-col gap-2">
                        <Label htmlFor="calendar-edit-repeat">Repeat</Label>
                        <Select
                          value={recurrenceFreq}
                          onValueChange={(val) => {
                            if (!val) return
                            const next = val as RecurrenceOption
                            setRecurrenceFreq(next)
                            if (next === "weekly" && recurrenceWeekdays.length === 0) {
                              setRecurrenceWeekdays([startDate.getDay()])
                            }
                          }}
                          items={[
                            { value: "none", label: "One-time" },
                            { value: "hourly", label: "Hourly" },
                            { value: "daily", label: "Daily" },
                            { value: "weekly", label: "Weekly" },
                            { value: "monthly", label: "Monthly" },
                          ]}
                        >
                          <SelectTrigger id="calendar-edit-repeat" className="h-11 w-full sm:h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">One-time</SelectItem>
                            <SelectItem value="hourly">Hourly</SelectItem>
                            <SelectItem value="daily">Daily</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                            <SelectItem value="monthly">Monthly</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {recurrenceFreq !== "none" ? (
                      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/50 p-4">
                        <div className="flex items-center gap-3">
                          <Label htmlFor="calendar-edit-interval" className="shrink-0 text-xs">
                            Every
                          </Label>
                          <Input
                            id="calendar-edit-interval"
                            type="number"
                            min={1}
                            max={365}
                            value={recurrenceInterval}
                            onChange={(e) => setRecurrenceInterval(Math.max(1, Number(e.target.value) || 1))}
                            className="h-9 w-20 font-mono tabular-nums"
                          />
                          <span className="text-xs text-muted-foreground">
                            {recurrenceFreq === "hourly"
                              ? "hour(s)"
                              : recurrenceFreq === "daily"
                                ? "day(s)"
                                : recurrenceFreq === "weekly"
                                  ? "week(s)"
                                  : "month(s)"}
                          </span>
                        </div>
                        {recurrenceFreq === "weekly" ? (
                          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repeat weekdays">
                            {WEEKDAY_CHOICES.map((choice) => {
                              const active = recurrenceWeekdays.includes(choice.value)
                              return (
                                <button
                                  key={choice.value}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => toggleWeekday(choice.value)}
                                  className={cn(
                                    "h-9 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                    active
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                                  )}
                                >
                                  {choice.label}
                                </button>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="calendar-edit-description">Notes</Label>
                      <Textarea
                        id="calendar-edit-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={4}
                        maxLength={4000}
                        placeholder="Reminder instructions or context for the bot…"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-muted/50 p-4">
                      <div className="flex flex-col gap-0.5">
                        <Label htmlFor="calendar-edit-paused" className="text-sm font-medium">
                          Pause schedule
                        </Label>
                        <span className="text-xs text-muted-foreground">
                          Skip automatic bot reminders until resumed.
                        </span>
                      </div>
                      <Switch
                        id="calendar-edit-paused"
                        checked={paused}
                        onCheckedChange={setPaused}
                      />
                    </div>

                    {mutationError ? (
                      <p role="alert" className="text-xs text-destructive">
                        {mutationError}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <div className="flex flex-col gap-6">
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Creator
                      </h3>
                      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3">
                        <CalendarActorAvatar actor={event.creator} size={32} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {event.creator.name}
                          </div>
                          {event.creator.handle ? (
                            <div className="truncate font-mono text-xs text-muted-foreground">
                              {event.creator.handle}
                            </div>
                          ) : null}
                        </div>
                        <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                          {event.creator.kind === "human" ? "Owner" : "Bot"}
                        </span>
                      </div>
                    </section>

                    {event.description ? (
                      <section className="flex flex-col gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Notes
                        </h3>
                        <p className="rounded-xl border border-border/60 bg-muted/50 p-4 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                          {event.description}
                        </p>
                      </section>
                    ) : null}

                    {event.recurrence.recurring ? (
                      <section className="flex flex-col gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Recurrence
                        </h3>
                        <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card p-4 text-sm">
                          <div className="font-medium text-foreground">{event.recurrence.label}</div>
                          {event.recurrence.ruleText ? (
                            <div className="font-mono text-xs text-muted-foreground">
                              {event.recurrence.ruleText}
                            </div>
                          ) : null}
                          {event.recurrence.nextRunAt ? (
                            <div className="pt-1 font-mono text-xs tabular-nums text-muted-foreground">
                              Next run: {formatFullDateTime(event.recurrence.nextRunAt)}
                            </div>
                          ) : null}
                        </div>
                      </section>
                    ) : null}

                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Bound message
                      </h3>
                      {event.sourceMessage.accessible ? (
                        <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4">
                          {event.sourceMessage.channelLabel ? (
                            <div className="text-xs font-medium text-muted-foreground">
                              {event.sourceMessage.channelLabel}
                            </div>
                          ) : null}
                          {event.sourceMessage.excerpt ? (
                            <p className="line-clamp-3 text-sm leading-relaxed text-foreground">
                              {event.sourceMessage.excerpt}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Scheduled reminders reply to message {event.sourceMessage.messageId}.
                            </p>
                          )}
                          <div>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              data-testid={tid.calendarSourceLink}
                              className="h-10 gap-2 sm:h-8"
                              onClick={() => onOpenSourceMessage(event.sourceMessage.messageId)}
                            >
                              <ExternalLink className="size-3.5" aria-hidden />
                              <span>Open original message</span>
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div
                          role="status"
                          className="flex items-start gap-3 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm"
                        >
                          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                          <div className="flex flex-col gap-1">
                            <span className="font-medium text-foreground">
                              Original message is unavailable
                            </span>
                            <span className="text-xs leading-relaxed text-muted-foreground">
                              {event.sourceMessage.unavailableReason
                                ?? "Access to the bound conversation was lost or the message was removed. Content is hidden and automatic replies cannot be posted."}
                            </span>
                          </div>
                        </div>
                      )}
                    </section>

                    {event.lastExecution ? (
                      <section className="flex flex-col gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Last run
                        </h3>
                        <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-card p-4 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <CalendarRunStatusBadge status={event.lastExecution.status} paused={event.paused} />
                            {event.lastExecution.ackedAt ?? event.lastExecution.updatedAt ?? event.lastExecution.scheduledAt ? (
                              <span className="font-mono tabular-nums text-muted-foreground">
                                {formatFullDateTime(
                                  (event.lastExecution.ackedAt ?? event.lastExecution.updatedAt ?? event.lastExecution.scheduledAt)!,
                                )}
                              </span>
                            ) : null}
                          </div>
                          {event.lastExecution.ackedAt ? (
                            <p className="text-muted-foreground">
                              Acknowledged by bot at {formatFullDateTime(event.lastExecution.ackedAt)}.
                            </p>
                          ) : null}
                          {event.lastExecution.lastError ? (
                            <p className="text-warning">{event.lastExecution.lastError}</p>
                          ) : null}
                        </div>
                      </section>
                    ) : null}

                    {mutationError ? (
                      <p role="alert" className="text-xs text-destructive">
                        {mutationError}
                      </p>
                    ) : null}
                  </div>
                )}
              </SheetBody>

              {(onSaveEvent || onDeleteEvent) ? (
                <SheetFooter>
                  {editing ? (
                    <>
                      <Button
                        key="calendar-edit-cancel"
                        type="button"
                        variant="ghost"
                        className="h-11 sm:h-9"
                        disabled={saving}
                        onClick={() => setEditing(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        key="calendar-edit-submit"
                        type="submit"
                        form="calendar-event-edit-form"
                        className="h-11 sm:h-9"
                        disabled={saving || !title.trim()}
                      >
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </>
                  ) : (
                    <>
                      {onDeleteEvent ? (
                        <Button
                          key="calendar-view-delete"
                          type="button"
                          variant="ghost"
                          className="h-11 gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive sm:mr-auto sm:h-9"
                          disabled={deleting}
                          onClick={() => setConfirmDeleteOpen(true)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                          <span>Delete event</span>
                        </Button>
                      ) : null}
                      {onSaveEvent ? (
                        <Button
                          key="calendar-view-edit"
                          type="button"
                          variant="secondary"
                          className="h-11 gap-2 sm:h-9"
                          onClick={beginEditing}
                        >
                          <Pencil className="size-4" aria-hidden />
                          <span>Edit event</span>
                        </Button>
                      ) : null}
                    </>
                  )}
                </SheetFooter>
              ) : null}
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete scheduled event?"
        description={
          event
            ? `Remove "${event.title}" from your shared calendar. Future automatic replies for this schedule will stop.`
            : "Remove this scheduled event from your shared calendar."
        }
        confirmLabel="Delete event"
        loadingLabel="Deleting…"
        loading={deleting}
        onConfirm={() => void handleDeleteConfirm()}
      />
    </>
  )
}
