"use client"

import { useState, type KeyboardEvent, type SubmitEvent } from "react"
import { LoaderCircle } from "@/components/icons/lucide"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { Button } from "@/components/ui/button"
import { SendStrokeRoundedIcon } from "../messages/send-stroke-rounded-icon"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { ApiError, isAbortError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import styles from "./community-inbox-popover.module.css"

function generateReplyNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `ir-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function formatInlineReplyError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Rate limited — wait a moment and try again."
    if (error.message.trim()) return error.message
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return "Could not send reply — try again."
}

export type InboxInlineReplyOutcome = void | { accepted?: boolean; error?: string }

export function InboxInlineReply({
  placeholder,
  inputLabel,
  inputTestId,
  sendTestId,
  disabled = false,
  className,
  onSend,
}: {
  placeholder: string
  inputLabel: string
  inputTestId: string
  sendTestId: string
  disabled?: boolean
  className?: string
  onSend: (content: string, nonce: string) => Promise<InboxInlineReplyOutcome>
}) {
  const hoverCapable = useHoverCapable()
  const [value, setValue] = useState("")
  const [sending, setSending] = useState(false)
  const [pendingNonce, setPendingNonce] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const trimmed = value.trim()
  const canSend = !disabled && !sending && trimmed.length > 0

  const submit = async () => {
    if (!canSend) return
    const nonce = pendingNonce ?? generateReplyNonce()
    if (pendingNonce === null) setPendingNonce(nonce)
    setErrorMessage(null)
    setSending(true)
    try {
      const outcome = await onSend(trimmed, nonce)
      if (outcome && outcome.accepted === false) {
        setPendingNonce(null)
        setErrorMessage(outcome.error ?? "Could not send reply — try again.")
        return
      }
      setValue("")
      setPendingNonce(null)
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(formatInlineReplyError(error))
      }
    } finally {
      setSending(false)
    }
  }

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter"
      || event.shiftKey
      || event.nativeEvent.isComposing
      || !hoverCapable
    ) {
      return
    }
    event.preventDefault()
    void submit()
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-message-controls=""
      data-swipe-ignore=""
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <div
        data-slot="inbox-reply-composer"
        className={cn(
          "relative rounded-[24px] bg-background/80 ring-1 transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none dark:bg-background/60",
          errorMessage
            ? "ring-destructive/60 focus-within:bg-background focus-within:ring-2 focus-within:ring-destructive/50"
            : "ring-border/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/55 dark:focus-within:bg-background/90",
        )}
      >
        <div className="py-3 pl-4 pr-16">
          <AutoResizeTextarea
            data-testid={inputTestId}
            rows={1}
            value={value}
            disabled={disabled || sending}
            placeholder={placeholder}
            aria-label={inputLabel}
            aria-invalid={errorMessage ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value)
              if (pendingNonce !== null) setPendingNonce(null)
              if (errorMessage) setErrorMessage(null)
            }}
            onKeyDown={handleKeyDown}
            className="block max-h-32 min-h-6 w-full overflow-y-auto thin-scrollbar bg-transparent text-base leading-6 text-foreground placeholder:text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm sm:leading-6"
          />
        </div>
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          data-testid={sendTestId}
          aria-label="Send reply"
          disabled={!canSend}
          className={cn("absolute right-0.5 bottom-0.5", styles.replySendButton)}
        >
          {sending
            ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            : <SendStrokeRoundedIcon className="size-5 -translate-x-px translate-y-px" />}
        </Button>
      </div>
      {errorMessage && (
        <p role="alert" className="wrap-anywhere text-xs font-medium text-destructive">
          {errorMessage}
        </p>
      )}
    </form>
  )
}
