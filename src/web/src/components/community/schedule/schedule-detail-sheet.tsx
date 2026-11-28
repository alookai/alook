"use client"

import { motion } from "motion/react"
import { TriangleAlertIcon } from "@/components/icons/lucide"
import { Avatar } from "@/components/community/avatar"
import { AttachmentCard } from "@/components/community/messages/attachment-card"
import { MessageAuthorLine } from "@/components/community/messages/message-author-line"
import { MessageBody } from "@/components/community/messages/message-body"
import { MessageImageAttachment } from "@/components/community/messages/message-image-attachment"
import { MessageReplyPreview } from "@/components/community/messages/message-reply-preview"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
import { formatMessageTime } from "@/lib/community/format-time"
import { selectHtmlPreviews } from "@/lib/community/html-preview-markdown"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ScheduleActorAvatar } from "./schedule-actor"
import { formatTimeRange } from "./schedule-date"
import {
  ScheduleRecurrenceBadge,
  ScheduleRunStatusBadge,
  ScheduleSourceRefPill,
  ScheduleSourceStatusBadge,
  ScheduleStatusDot,
} from "./schedule-status"
import type {
  ScheduleBoundMessage,
  ScheduleBoundMessageState,
  ScheduleOccurrenceItem,
  ScheduleSourceMessage,
} from "./schedule-types"
import styles from "./schedule.module.css"

const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1]

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

function BoundMessageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading bound message"
      data-schedule-bound-message="loading"
      className="flex items-start gap-2.5"
    >
      <div className={cn(styles.skeletonShimmer, "size-10 shrink-0 rounded-full")} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <div className="flex items-center gap-2">
          <div className={cn(styles.skeletonShimmer, "h-4 w-24 rounded-md")} />
          <div className={cn(styles.skeletonShimmer, "h-3 w-14 rounded-md")} />
        </div>
        <div className={cn(styles.skeletonShimmer, "h-4 w-full max-w-88 rounded-md")} />
        <div className={cn(styles.skeletonShimmer, "h-4 w-3/4 max-w-64 rounded-md")} />
      </div>
    </div>
  )
}

function BoundMessageRendered({ message }: { message: ScheduleBoundMessage }) {
  const visibleContent = message.content ?? ""
  const htmlPreviews = selectHtmlPreviews(visibleContent, message.attachments)
  const visibleAttachments = (message.attachments ?? []).filter(
    (attachment) => !(attachment.id && htmlPreviews.has(attachment.id)),
  )

  return (
    <motion.div
      key={message.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: EASE_OUT_EXPO }}
      data-schedule-bound-message="ready"
      className="flex flex-col gap-2"
    >
      {message.replyTo ? (
        <MessageReplyPreview
          reply={message.replyTo}
          authorName={message.replyAuthorName ?? "Unknown"}
        />
      ) : null}

      <div className="flex items-start gap-2">
        <Avatar
          label={message.authorAvatar}
          seed={message.authorId}
          size={40}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <MessageAuthorLine
            authorName={message.authorName}
            timestamp={message.createdAt ? formatMessageTime(message.createdAt) : undefined}
            timestampProps={message.createdAt ? { dateTime: message.createdAt } : undefined}
          />

          {visibleContent ? (
            <MessageBody
              key={message.id}
              text={visibleContent}
              attachments={message.attachments}
            />
          ) : null}

          {visibleAttachments.length > 0 ? (
            <div className="flex flex-col gap-2 pt-0.5">
              {visibleAttachments.map((attachment, index) => {
                if (attachment.kind === "image") {
                  return (
                    <MessageImageAttachment
                      key={`${message.id}:${index}`}
                      testId={`community-schedule-bound-image-${index}`}
                      attachment={attachment}
                    />
                  )
                }
                return <AttachmentCard key={`${message.id}:${index}`} attachment={attachment} />
              })}
            </div>
          ) : null}

          {!visibleContent && visibleAttachments.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">Empty message</p>
          ) : null}
        </div>
      </div>
    </motion.div>
  )
}

function BoundMessageSection({
  source,
  boundMessage,
}: {
  source: ScheduleSourceMessage
  boundMessage?: ScheduleBoundMessageState
}) {
  const unavailable = !source.accessible || boundMessage?.status === "unavailable"

  return (
    <section className="flex flex-col gap-3 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Bound message
        </h3>
        {!unavailable ? (
          <div className="text-xs">
            <ScheduleSourceRefPill
              source={source}
              testId={tid.scheduleSourceLink}
            />
          </div>
        ) : null}
      </div>

      {unavailable ? (
        <div role="status" className="flex items-start gap-2.5 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-foreground">
              Original message is unavailable
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {source.unavailableReason
                ?? "Access to the bound conversation was lost or the message was removed. Content is hidden and automatic replies cannot be posted."}
            </span>
          </div>
        </div>
      ) : boundMessage?.status === "loading" ? (
        <BoundMessageSkeleton />
      ) : boundMessage?.status === "ready" && boundMessage.message ? (
        <BoundMessageRendered message={boundMessage.message} />
      ) : (
        <div className="flex flex-col gap-2">
          {source.excerpt ? (
            <p className="max-w-[65ch] text-[15px] leading-snug whitespace-pre-wrap text-foreground">
              {source.excerpt}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Scheduled tasks reply to this message.
            </p>
          )}
          {boundMessage?.status === "error" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Couldn’t load the full message.</span>
              {boundMessage.onRetry ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11 px-2 text-xs sm:h-7"
                  onClick={boundMessage.onRetry}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

export function ScheduleDetailSheet({
  occurrence,
  open,
  onOpenChange,
  boundMessage,
}: {
  occurrence: ScheduleOccurrenceItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  boundMessage?: ScheduleBoundMessageState
}) {
  const event = occurrence?.event ?? null
  const runStatus = occurrence?.runStatus ?? event?.lastExecution?.status ?? null
  const scheduleSummary = event && occurrence
    ? `${formatDateOnly(occurrence.startAt)} · ${formatTimeRange(occurrence.startAt, occurrence.endAt)}${event.timeZone ? ` · ${event.timeZone}` : ""}`
    : undefined

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      desktopWidth={500}
      contentTestId={tid.scheduleDetailSheet}
      title={event?.title ?? "Scheduled task"}
      description={
        scheduleSummary ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {scheduleSummary}
          </span>
        ) : undefined
      }
      bodyClassName="px-0 py-0"
    >
      {event && occurrence ? (
        <motion.div
          key={occurrence.occurrenceKey}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
          className="flex flex-col divide-y divide-border/50"
        >
          <section className="flex flex-col gap-4 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-1.5">
              <ScheduleRecurrenceBadge recurrence={event.recurrence} />
              <ScheduleSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} />
              <ScheduleRunStatusBadge status={runStatus} />
            </div>

            {event.description ? (
              <p className="max-w-[65ch] text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                {event.description}
              </p>
            ) : null}

            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-[7.25rem_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-3">
              <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">
                Scheduled by
              </dt>
              <dd className="flex min-w-0 items-center gap-2">
                <ScheduleActorAvatar actor={event.creator} size={20} />
                <span className="truncate text-sm font-medium text-foreground">
                  {event.creator.name}
                </span>
                {event.creator.handle ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {event.creator.handle}
                  </span>
                ) : null}
              </dd>

              {event.recurrence.recurring ? (
                <>
                  <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">
                    Recurrence
                  </dt>
                  <dd className="flex min-w-0 flex-col gap-0.5 text-sm">
                    <span className="font-medium text-foreground">{event.recurrence.label}</span>
                    {event.recurrence.ruleText ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {event.recurrence.ruleText}
                      </span>
                    ) : null}
                    {event.recurrence.nextRunAt ? (
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        Next run: {formatFullDateTime(event.recurrence.nextRunAt)}
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}

              {event.lastExecution ? (
                <>
                  <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">
                    Last run
                  </dt>
                  <dd className="flex min-w-0 flex-col gap-1 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      {event.lastExecution.status !== runStatus ? (
                        <ScheduleRunStatusBadge status={event.lastExecution.status} />
                      ) : (
                        <ScheduleStatusDot status={event.lastExecution.status} size="sm" />
                      )}
                      {event.lastExecution.ackedAt ?? event.lastExecution.updatedAt ?? event.lastExecution.scheduledAt ? (
                        <span className="font-mono tabular-nums text-foreground/85">
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
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          <BoundMessageSection
            source={event.sourceMessage}
            boundMessage={boundMessage}
          />
        </motion.div>
      ) : null}
    </CommunitySheet>
  )
}
