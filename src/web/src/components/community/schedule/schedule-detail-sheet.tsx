"use client"

import { ExternalLink, TriangleAlertIcon } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { tid } from "@/lib/community/testids"
import { ScheduleActorAvatar } from "./schedule-actor"
import { formatTimeRange } from "./schedule-date"
import {
  ScheduleRecurrenceBadge,
  ScheduleRunStatusBadge,
  ScheduleSourceStatusBadge,
} from "./schedule-status"
import type { ScheduleOccurrenceItem } from "./schedule-types"

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

export function ScheduleDetailSheet({
  occurrence,
  open,
  onOpenChange,
  onOpenSourceMessage,
}: {
  occurrence: ScheduleOccurrenceItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenSourceMessage: (messageId: string) => void
}) {
  const event = occurrence?.event ?? null
  const runStatus = occurrence?.runStatus ?? event?.lastExecution?.status ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid={tid.scheduleDetailSheet}
        className="sm:max-w-lg"
      >
        {event && occurrence ? (
          <>
            <SheetHeader className="pr-12">
              <div className="flex flex-wrap items-center gap-1.5">
                <ScheduleRecurrenceBadge recurrence={event.recurrence} />
                <ScheduleSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} />
                <ScheduleRunStatusBadge status={runStatus} />
              </div>
              <SheetTitle className="mt-1">{event.title}</SheetTitle>
              <SheetDescription className="font-mono text-xs tabular-nums">
                {formatDateOnly(occurrence.startAt)} · {formatTimeRange(occurrence.startAt, occurrence.endAt)}
                {event.timeZone ? ` · ${event.timeZone}` : ""}
              </SheetDescription>
            </SheetHeader>

            <SheetBody>
              <div className="flex flex-col gap-5">
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Scheduled by
                  </h3>
                  <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3.5">
                    <ScheduleActorAvatar actor={event.creator} size={32} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {event.creator.name}
                      </span>
                      {event.creator.handle ? (
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {event.creator.handle}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </section>

                {event.description ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Description
                    </h3>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                      {event.description}
                    </p>
                  </section>
                ) : null}

                {event.recurrence.recurring ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                          Scheduled tasks reply to message {event.sourceMessage.messageId}.
                        </p>
                      )}
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          data-testid={tid.scheduleSourceLink}
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
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Last run
                    </h3>
                    <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-card p-4 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <ScheduleRunStatusBadge status={event.lastExecution.status} />
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
              </div>
            </SheetBody>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
