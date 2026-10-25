"use client"

import { PII_TEXT_MAX_BYTES, utf8ByteLength } from "@alook/shared"
import { ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export function BotPiiPlayground({ value, onValueChange, result, pending, error, disabled, onRun }: {
  value: string
  onValueChange: (value: string) => void
  result?: string
  pending: boolean
  error?: string
  disabled?: boolean
  onRun: () => void
}) {
  const tooLong = utf8ByteLength(value) > PII_TEXT_MAX_BYTES
  return (
    <section className="flex min-w-0 flex-col gap-8" aria-labelledby="pii-playground-heading">
      <h2 id="pii-playground-heading" className="text-lg font-medium">Playground</h2>
      <div className="flex min-h-40 flex-col gap-4" aria-live="polite" aria-busy={pending}>
        <h3 id="pii-output-label" className="text-sm font-medium text-muted-foreground">Filtered output</h3>
        {pending ? <p role="status" className="text-base text-muted-foreground">Running on your computer…</p>
          : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
          : result !== undefined ? <output aria-labelledby="pii-output-label" className="block max-w-prose whitespace-pre-wrap wrap-anywhere text-base leading-relaxed">{result || "The filtered message is empty."}</output>
          : <p className="max-w-prose text-base leading-relaxed text-muted-foreground">Run a message to see the filtered result here.</p>}
      </div>
      <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (!pending && !disabled && !tooLong && value.trim()) onRun() }}>
        <label htmlFor="pii-playground-input" className="text-sm font-medium">Try a message</label>
        <p id="pii-playground-notice" className="max-w-prose text-sm leading-relaxed text-muted-foreground">We don’t store this message. It is sent to your computer for testing.</p>
        <Textarea aria-describedby="pii-playground-notice" id="pii-playground-input" data-testid="pii-playground-input" value={value} onChange={event => onValueChange(event.target.value)} placeholder="Type a message to test these filters…" className="min-h-32 resize-y p-4 text-base leading-relaxed" disabled={pending} />
        {tooLong ? <p role="alert" className="text-sm text-destructive">Use 1,024 UTF-8 bytes or fewer.</p> : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">Test only. No chat message is sent.</p>
          <Button type="submit" disabled={pending || disabled || tooLong || !value.trim()} className="min-h-11 gap-2 px-4" data-testid="pii-playground-run">{pending ? "Running…" : "Run pipeline"}<ArrowUp className="size-4" /></Button>
        </div>
      </form>
    </section>
  )
}
