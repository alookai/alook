"use client"

import { useState, type KeyboardEvent, type SubmitEvent } from "react"
import { ComposerSendButton } from "../messages/composer-send-button"
import { ApiError, isAbortError } from "@/lib/errors"
import { cn } from "@/lib/utils"

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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
      return
    }
    event.preventDefault()
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
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
          "relative rounded-full bg-background/80 ring-1 transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none dark:bg-background/60",
          errorMessage
            ? "ring-destructive/60 focus-within:bg-background focus-within:ring-2 focus-within:ring-destructive/50"
            : "ring-border/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/55 dark:focus-within:bg-background/90",
        )}
      >
        <div className="py-3 pl-4 pr-16 sm:pr-12">
          <input
            type="text"
            enterKeyHint="send"
            data-testid={inputTestId}
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
            className="block h-6 w-full truncate bg-transparent text-base leading-6 text-foreground placeholder:text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm sm:leading-6"
          />
        </div>
        <ComposerSendButton
          type="submit"
          testId={sendTestId}
          ariaLabel="Send reply"
          disabled={!canSend}
          sending={sending}
        />
      </div>
      {errorMessage && (
        <p role="alert" className="wrap-anywhere text-xs font-medium text-destructive">
          {errorMessage}
        </p>
      )}
    </form>
  )
}
