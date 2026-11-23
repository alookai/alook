"use client"

import { useMemo, useState, type ReactNode } from "react"
import {
  DECISION_CARD_OTHER_TEXT_MAX_LENGTH,
  formatDecisionCardAnswerMessage,
  parseNameAndTag,
  validateDecisionCardAnswers,
  type DecisionCardAnswerInput,
  type DecisionCardAssignee,
  type DecisionCardEmbed,
  type DecisionCardNormalizedQuestion,
} from "@alook/shared"
import { Check, ChevronDown } from "@/components/icons/lucide"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import { isAbortError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { tid } from "@/lib/community/testids"
import type { OpenProfile } from "../social/profile-types"
import { MentionPill } from "./inline-marks"

const OTHER_RADIO_VALUE = "__decision_card_other__"

type QuestionDraft = {
  selectedOptionIds: string[]
  otherSelected: boolean
  otherText: string
}

type DraftMap = Record<string, QuestionDraft>

function createInitialDraft(card: DecisionCardEmbed): DraftMap {
  const draft: DraftMap = {}
  for (const question of card.questions) {
    draft[question.id] = {
      selectedOptionIds: [],
      otherSelected: false,
      otherText: "",
    }
  }
  return draft
}

function isQuestionAnswered(
  question: DecisionCardNormalizedQuestion,
  entry: QuestionDraft | undefined,
): boolean {
  if (!entry) return false
  const hasOther = question.allowOther && entry.otherSelected
  if (hasOther && entry.otherText.trim().length === 0) return false
  return entry.selectedOptionIds.length > 0 || (hasOther && entry.otherText.trim().length > 0)
}

function findNextUnansweredId(
  questions: readonly DecisionCardNormalizedQuestion[],
  draft: DraftMap,
  currentIndex: number,
): string | null {
  for (let offset = 1; offset < questions.length; offset += 1) {
    const candidate = questions[(currentIndex + offset) % questions.length]
    if (candidate && !isQuestionAnswered(candidate, draft[candidate.id])) {
      return candidate.id
    }
  }
  return null
}

function generateNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `dc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function resolveAssigneeIdentity(
  assignee: DecisionCardAssignee,
  canonical: { name?: string | null; discriminator?: string | null } | undefined,
) {
  const parsed = parseNameAndTag(assignee.handle)
  const name = canonical?.name?.trim() || parsed?.name || assignee.handle
  const discriminator = canonical?.discriminator?.trim() || parsed?.discriminator || undefined
  return { name, discriminator }
}

function AssigneeMention({
  assignee,
  answered,
  onOpenProfile,
}: {
  assignee: DecisionCardAssignee
  answered?: boolean
  onOpenProfile?: OpenProfile
}) {
  const canonical = useCanonicalCommunityProfile(assignee.userId)
  const { name, discriminator } = resolveAssigneeIdentity(assignee, canonical)
  const fullLabel = discriminator ? `@${name}#${discriminator}` : `@${name}`
  return (
    <span className="inline-flex items-center gap-1">
      <MentionPill
        label={fullLabel}
        onClick={onOpenProfile ? (e) => onOpenProfile(name, e, discriminator, assignee.userId) : undefined}
      >
        @{name}
      </MentionPill>
      {answered && <Check className="size-3 text-primary" aria-label="Responded" />}
    </span>
  )
}

export type DecisionCardSubmitHandler = (
  messageId: string,
  content: string,
  nonce: string,
) => Promise<{ replyToId: string | null }>

export function DecisionCard({
  card,
  messageId,
  authorId,
  viewerUserId,
  onSubmit,
  liveRespondedUserIds,
  onOpenProfile,
  compact,
  header,
  footer,
  className,
}: {
  card: DecisionCardEmbed
  messageId: string
  authorId?: string
  viewerUserId?: string
  onSubmit?: DecisionCardSubmitHandler
  liveRespondedUserIds?: readonly string[]
  onOpenProfile?: OpenProfile
  compact?: boolean
  header?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const [draft, setDraft] = useState<DraftMap>(() => createInitialDraft(card))
  const [activeQuestionId, setActiveQuestionId] = useState<string>(() => card.questions[0]?.id ?? "")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submittedNotice, setSubmittedNotice] = useState(false)
  const [pendingNonce, setPendingNonce] = useState<string | null>(null)
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)

  const respondedUserIds = useMemo(() => {
    const set = new Set<string>()
    for (const id of card.respondedUserIds ?? []) {
      if (id && id !== authorId) set.add(id)
    }
    for (const id of liveRespondedUserIds ?? []) {
      if (id && id !== authorId) set.add(id)
    }
    return set
  }, [card.respondedUserIds, liveRespondedUserIds, authorId])

  const hasAssignees = card.assignees.length > 0
  const viewerIsAssignee = !hasAssignees
    || (viewerUserId !== undefined && card.assignees.some((assignee) => assignee.userId === viewerUserId))
  const viewerHasResponded = Boolean(viewerUserId && respondedUserIds.has(viewerUserId))
  const viewerDismissed = card.viewerDismissed === true
  const viewerNotMentioned = hasAssignees && !viewerIsAssignee
  const defaultCollapsed = viewerHasResponded || viewerNotMentioned || viewerDismissed
  const collapsed = expandedOverride !== null ? !expandedOverride : defaultCollapsed
  const interactive = !compact && Boolean(onSubmit) && viewerIsAssignee
  const disabled = !interactive || submitting

  const isMultiQuestion = card.questions.length > 1
  const currentQuestionIndex = Math.max(
    0,
    card.questions.findIndex((question) => question.id === activeQuestionId),
  )
  const currentQuestion = card.questions[currentQuestionIndex] ?? card.questions[0]
  const resolvedActiveId = currentQuestion?.id ?? ""

  const answeredCount = card.questions.filter((question) =>
    isQuestionAnswered(question, draft[question.id]),
  ).length
  const allAnswered = answeredCount === card.questions.length
  const currentAnswered = currentQuestion
    ? isQuestionAnswered(currentQuestion, draft[currentQuestion.id])
    : false
  const nextUnansweredId = isMultiQuestion
    ? findNextUnansweredId(card.questions, draft, currentQuestionIndex)
    : null

  const respondedAssigneeCount = hasAssignees
    ? card.assignees.filter((assignee) => respondedUserIds.has(assignee.userId)).length
    : respondedUserIds.size

  const clearFeedbackForEdit = () => {
    if (pendingNonce !== null) setPendingNonce(null)
    if (errorMessage) setErrorMessage(null)
    if (submittedNotice) setSubmittedNotice(false)
  }

  const selectSingleValue = (
    question: DecisionCardNormalizedQuestion,
    qIndex: number,
    value: string,
  ) => {
    if (disabled) return
    clearFeedbackForEdit()
    const current = draft[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" }
    if (value === OTHER_RADIO_VALUE) {
      if (!question.allowOther) return
      setDraft((prev) => ({
        ...prev,
        [question.id]: {
          ...current,
          selectedOptionIds: [],
          otherSelected: true,
        },
      }))
      return
    }
    const nextDraft: DraftMap = {
      ...draft,
      [question.id]: {
        ...current,
        selectedOptionIds: [value],
        otherSelected: false,
      },
    }
    setDraft(nextDraft)
    if (isMultiQuestion) {
      const nextId = findNextUnansweredId(card.questions, nextDraft, qIndex)
      if (nextId) setActiveQuestionId(nextId)
    }
  }

  const toggleMultiOption = (question: DecisionCardNormalizedQuestion, optionId: string) => {
    if (disabled) return
    clearFeedbackForEdit()
    setDraft((prev) => {
      const current = prev[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" }
      const exists = current.selectedOptionIds.includes(optionId)
      return {
        ...prev,
        [question.id]: {
          ...current,
          selectedOptionIds: exists
            ? current.selectedOptionIds.filter((id) => id !== optionId)
            : [...current.selectedOptionIds, optionId],
        },
      }
    })
  }

  const toggleMultiOther = (question: DecisionCardNormalizedQuestion) => {
    if (disabled || !question.allowOther) return
    clearFeedbackForEdit()
    setDraft((prev) => {
      const current = prev[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" }
      return {
        ...prev,
        [question.id]: {
          ...current,
          otherSelected: !current.otherSelected,
        },
      }
    })
  }

  const updateOtherText = (questionId: string, value: string) => {
    if (disabled) return
    clearFeedbackForEdit()
    setDraft((prev) => {
      const current = prev[questionId] ?? { selectedOptionIds: [], otherSelected: true, otherText: "" }
      return {
        ...prev,
        [questionId]: {
          ...current,
          otherSelected: true,
          otherText: value,
        },
      }
    })
  }

  const advanceToNextQuestion = () => {
    if (!nextUnansweredId) return
    setActiveQuestionId(nextUnansweredId)
  }

  const handleSubmit = async () => {
    if (!interactive || !onSubmit || submitting || !allAnswered) return
    const payload: DecisionCardAnswerInput = {
      answers: card.questions.map((question) => {
        const entry = draft[question.id]
        const selectedOptionIds = entry?.selectedOptionIds ?? []
        const otherText = entry?.otherSelected ? entry.otherText.trim() : ""
        return {
          questionId: question.id,
          ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
          ...(otherText ? { otherText } : {}),
        }
      }),
    }

    const check = validateDecisionCardAnswers(card, payload)
    if (!check.ok) {
      setErrorMessage(check.error)
      return
    }

    setErrorMessage(null)
    setSubmittedNotice(false)
    const content = formatDecisionCardAnswerMessage(card, check.resolved)
    const nonce = pendingNonce ?? generateNonce()
    if (pendingNonce === null) setPendingNonce(nonce)
    setSubmitting(true)

    try {
      const receipt = await onSubmit(messageId, content, nonce)
      if (receipt.replyToId !== messageId) {
        setPendingNonce(null)
        setErrorMessage("Could not link your answer to this question — reload and try again.")
        return
      }
      setPendingNonce(null)
      setSubmittedNotice(true)
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(error instanceof Error ? error.message : "Could not send answer — try again.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const optionRowClass =
    "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors has-data-disabled:pointer-events-none has-data-disabled:opacity-60 sm:min-h-9"

  const renderQuestionBlock = (question: DecisionCardNormalizedQuestion, qIndex: number) => {
    const entry = draft[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" }
    const singleValue = entry.otherSelected
      ? OTHER_RADIO_VALUE
      : (entry.selectedOptionIds[0] ?? "")

    const handleOtherKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return
      if (!isQuestionAnswered(question, entry)) return
      if (isMultiQuestion && nextUnansweredId) {
        event.preventDefault()
        setActiveQuestionId(nextUnansweredId)
      }
    }

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          {((!isMultiQuestion && question.header) || question.multiSelect) && (
            <div className="flex flex-wrap items-center gap-2">
              {!isMultiQuestion && question.header && (
                <Badge variant="secondary" className="text-xs font-medium">
                  {question.header}
                </Badge>
              )}
              {question.multiSelect && (
                <span className="text-xs text-muted-foreground">Select all that apply</span>
              )}
            </div>
          )}
          <p className="wrap-anywhere text-sm font-medium leading-snug text-foreground">
            {isMultiQuestion ? `${qIndex + 1}. ` : ""}
            {question.question}
          </p>
        </div>

        {question.multiSelect ? (
          <div
            role="group"
            aria-label={question.header ?? question.question}
            className="grid w-full gap-1"
          >
            {question.options.map((option) => {
              const selected = entry.selectedOptionIds.includes(option.id)
              return (
                <FieldLabel
                  key={option.id}
                  data-selected={selected || undefined}
                  data-testid={tid.decisionCardOption(question.id, option.id)}
                  className={optionRowClass}
                >
                  <Checkbox
                    checked={selected}
                    disabled={disabled}
                    onCheckedChange={() => toggleMultiOption(question, option.id)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium leading-snug text-foreground">
                      <span className="wrap-anywhere">{option.label}</span>
                      {option.recommended && (
                        <Badge variant="secondary" className="text-[11px] font-medium">
                          Recommended
                        </Badge>
                      )}
                    </span>
                    {option.description && (
                      <span className="wrap-anywhere text-xs font-normal leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </FieldLabel>
              )
            })}

            {question.allowOther && (
              entry.otherSelected ? (
                <div
                  data-slot="field-label"
                  data-selected="true"
                  data-testid={tid.decisionCardOtherToggle(question.id)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-ring/40 has-data-disabled:pointer-events-none has-data-disabled:opacity-60 sm:min-h-9"
                >
                  <Checkbox
                    checked={entry.otherSelected}
                    disabled={disabled}
                    onCheckedChange={() => toggleMultiOther(question)}
                  />
                  <input
                    type="text"
                    value={entry.otherText}
                    disabled={disabled}
                    maxLength={DECISION_CARD_OTHER_TEXT_MAX_LENGTH}
                    placeholder="Write your answer..."
                    aria-label={`Other answer for ${question.header ?? question.question}`}
                    data-testid={tid.decisionCardOtherInput(question.id)}
                    onChange={(event) => updateOtherText(question.id, event.target.value)}
                    onKeyDown={handleOtherKeyDown}
                    className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm font-medium leading-snug text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground disabled:cursor-not-allowed"
                    autoFocus
                  />
                </div>
              ) : (
                <FieldLabel
                  data-testid={tid.decisionCardOtherToggle(question.id)}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors has-data-disabled:pointer-events-none has-data-disabled:opacity-60 sm:min-h-9"
                >
                  <Checkbox
                    checked={false}
                    disabled={disabled}
                    onCheckedChange={() => toggleMultiOther(question)}
                  />
                  <span className="text-sm font-medium leading-snug text-foreground">Other</span>
                </FieldLabel>
              )
            )}
          </div>
        ) : (
          <RadioGroup
            value={singleValue}
            onValueChange={(value) => selectSingleValue(question, qIndex, String(value))}
            aria-label={question.header ?? question.question}
            className="gap-1"
          >
            {question.options.map((option) => {
              const selected = singleValue === option.id
              return (
                <FieldLabel
                  key={option.id}
                  data-selected={selected || undefined}
                  data-testid={tid.decisionCardOption(question.id, option.id)}
                  className={optionRowClass}
                >
                  <RadioGroupItem
                    value={option.id}
                    disabled={disabled}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium leading-snug text-foreground">
                      <span className="wrap-anywhere">{option.label}</span>
                      {option.recommended && (
                        <Badge variant="secondary" className="text-[11px] font-medium">
                          Recommended
                        </Badge>
                      )}
                    </span>
                    {option.description && (
                      <span className="wrap-anywhere text-xs font-normal leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </FieldLabel>
              )
            })}

            {question.allowOther && (
              entry.otherSelected ? (
                <div
                  data-slot="field-label"
                  data-selected="true"
                  data-testid={tid.decisionCardOtherToggle(question.id)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-ring/40 has-data-disabled:pointer-events-none has-data-disabled:opacity-60 sm:min-h-9"
                >
                  <RadioGroupItem
                    value={OTHER_RADIO_VALUE}
                    disabled={disabled}
                  />
                  <input
                    type="text"
                    value={entry.otherText}
                    disabled={disabled}
                    maxLength={DECISION_CARD_OTHER_TEXT_MAX_LENGTH}
                    placeholder="Write your answer..."
                    aria-label={`Other answer for ${question.header ?? question.question}`}
                    data-testid={tid.decisionCardOtherInput(question.id)}
                    onChange={(event) => updateOtherText(question.id, event.target.value)}
                    onKeyDown={handleOtherKeyDown}
                    className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm font-medium leading-snug text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground disabled:cursor-not-allowed"
                    autoFocus
                  />
                </div>
              ) : (
                <FieldLabel
                  data-testid={tid.decisionCardOtherToggle(question.id)}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors has-data-disabled:pointer-events-none has-data-disabled:opacity-60 sm:min-h-9"
                >
                  <RadioGroupItem
                    value={OTHER_RADIO_VALUE}
                    disabled={disabled}
                  />
                  <span className="text-sm font-medium leading-snug text-foreground">Other</span>
                </FieldLabel>
              )
            )}
          </RadioGroup>
        )}
      </div>
    )
  }

  const collapsedTitle = card.summary ?? card.questions[0]?.question ?? "Decision card"
  const statusBadge = viewerHasResponded ? (
    <Badge variant="secondary" className="shrink-0 gap-1 text-[11px] font-medium">
      <Check isAnimated={false} className="size-3 text-primary" aria-hidden />
      <span>Answered</span>
    </Badge>
  ) : viewerDismissed ? (
    <Badge variant="secondary" className="shrink-0 text-[11px] font-medium text-muted-foreground">
      Dismissed
    </Badge>
  ) : viewerNotMentioned ? (
    hasAssignees && respondedAssigneeCount === card.assignees.length ? (
      <Badge variant="secondary" className="shrink-0 gap-1 text-[11px] font-medium">
        <Check isAnimated={false} className="size-3 text-primary" aria-hidden />
        <span>Answered</span>
      </Badge>
    ) : (
      <Badge variant="secondary" className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {card.questions.length === 1 ? "Question" : `${card.questions.length} questions`}
      </Badge>
    )
  ) : null

  const respondersRow = hasAssignees ? (
    <div
      data-testid={tid.decisionCardResponders}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {card.assignees.map((assignee) => (
        <AssigneeMention
          key={assignee.userId}
          assignee={assignee}
          answered={respondedUserIds.has(assignee.userId)}
          onOpenProfile={onOpenProfile}
        />
      ))}
      <span>
        {respondedAssigneeCount}/{card.assignees.length} responded
      </span>
    </div>
  ) : (
    respondedUserIds.size > 0 && (
      <p data-testid={tid.decisionCardResponders} className="text-xs text-muted-foreground">
        {respondedUserIds.size === 1
          ? "1 person responded"
          : `${respondedUserIds.size} people responded`}
      </p>
    )
  )

  if (collapsed) {
    return (
      <Card
        size="sm"
        surface="sticker"
        role="region"
        aria-label={card.summary ?? "Decision card"}
        data-testid={tid.decisionCard}
        data-collapsed="true"
        data-message-controls=""
        data-swipe-ignore=""
        className={cn("my-2 w-full max-w-lg min-w-0", className)}
      >
        <CardContent className="flex flex-col gap-1.5">
          {header && (
            <div className="border-b border-border/60 pb-3">
              {header}
            </div>
          )}
          <button
            type="button"
            data-testid={tid.decisionCardToggle}
            aria-expanded={false}
            aria-label={`Expand ${collapsedTitle}`}
            onClick={() => setExpandedOverride(true)}
            className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-md text-left transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-7"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold leading-snug tracking-[-0.015em] text-foreground">
                {collapsedTitle}
              </span>
              {statusBadge}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
              <span>Show</span>
              <ChevronDown isAnimated={false} className="size-4" aria-hidden />
            </span>
          </button>
          {respondersRow}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card
      size="sm"
      surface="sticker"
      role="region"
      aria-label={card.summary ?? "Decision card"}
      data-testid={tid.decisionCard}
      data-message-controls=""
      data-swipe-ignore=""
      className={cn("my-2 w-full max-w-lg min-w-0", className)}
    >
      <CardContent className={cn("flex flex-col", header || footer ? "gap-3" : "gap-4")}>
        {header && (
          <div className="border-b border-border/60 pb-2.5">
            {header}
          </div>
        )}
        {(card.summary || hasAssignees || respondedUserIds.size > 0 || defaultCollapsed) && (
          <div className="flex flex-col gap-1.5">
            {(card.summary || defaultCollapsed) && (
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {card.summary && (
                    <p className="wrap-anywhere text-sm font-semibold leading-snug tracking-[-0.015em] text-foreground">
                      {card.summary}
                    </p>
                  )}
                  {statusBadge}
                </div>
                {defaultCollapsed && (
                  <button
                    type="button"
                    data-testid={tid.decisionCardToggle}
                    aria-expanded={true}
                    aria-label={`Collapse ${collapsedTitle}`}
                    onClick={() => setExpandedOverride(false)}
                    className="-mr-1.5 inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-7"
                  >
                    <span>Hide</span>
                    <ChevronDown isAnimated={false} className="size-4 rotate-180" aria-hidden />
                  </button>
                )}
              </div>
            )}
            {respondersRow}
          </div>
        )}

        {isMultiQuestion ? (
          <Tabs
            value={resolvedActiveId}
            onValueChange={(value) => setActiveQuestionId(String(value))}
            className="gap-3"
          >
            <TabsList className="thin-scrollbar">
              {card.questions.map((question, qIndex) => {
                const answered = isQuestionAnswered(question, draft[question.id])
                return (
                  <TabsTrigger
                    key={question.id}
                    value={question.id}
                    data-testid={tid.decisionCardTab(question.id)}
                    className="gap-1.5"
                  >
                    <span>{question.header ?? `Q${qIndex + 1}`}</span>
                    {answered && <Check className="size-3 text-primary" aria-hidden />}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            {card.questions.map((question, qIndex) => (
              <TabsContent key={question.id} value={question.id}>
                {renderQuestionBlock(question, qIndex)}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          currentQuestion && renderQuestionBlock(currentQuestion, 0)
        )}

        {errorMessage && (
          <p role="alert" className="wrap-anywhere text-xs font-medium text-destructive">
            {errorMessage}
          </p>
        )}

        {interactive ? (
          (allAnswered || (isMultiQuestion && currentAnswered && nextUnansweredId) || submittedNotice || isMultiQuestion) && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {allAnswered ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={submitting}
                  data-testid={tid.decisionCardSubmit}
                  onClick={handleSubmit}
                  className="h-11 sm:h-9"
                >
                  {submitting
                    ? "Sending…"
                    : isMultiQuestion
                      ? "Send answers"
                      : "Send answer"}
                </Button>
              ) : isMultiQuestion && currentAnswered && nextUnansweredId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={submitting}
                  data-testid={tid.decisionCardNext}
                  onClick={advanceToNextQuestion}
                  className="h-11 sm:h-9"
                >
                  Next
                </Button>
              ) : isMultiQuestion ? (
                <span className="text-xs text-muted-foreground">
                  {answeredCount}/{card.questions.length} answered
                </span>
              ) : null}

              {submittedNotice && (
                <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check className="size-3.5 text-primary" aria-hidden />
                  <span>Answer sent</span>
                </span>
              )}
            </div>
          )
        ) : (
          hasAssignees && !viewerIsAssignee && (
            <p data-testid={tid.decisionCardReadonlyNotice} className="text-xs text-muted-foreground">
              {"Waiting for "}
              {card.assignees.map((assignee, idx) => (
                <span key={assignee.userId}>
                  {idx > 0 ? ", " : null}
                  <AssigneeMention assignee={assignee} onOpenProfile={onOpenProfile} />
                </span>
              ))}
              {" to answer"}
            </p>
          )
        )}

        {footer && (
          <div className="border-t border-border/60 pt-3">
            {footer}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
