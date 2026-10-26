"use client"

import { PII_TEXT_MAX_BYTES, utf8ByteLength } from "@alook/shared"
import { Check, ListFilter, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import styles from "./bot-pii-playground.module.css"

export function BotPiiPlayground({ value, onValueChange, result, triggeredFilters, pending, error, disabled, onRun }: {
  value: string
  onValueChange: (value: string) => void
  result?: string
  triggeredFilters?: { id: string; name: string }[]
  pending: boolean
  error?: string
  disabled?: boolean
  onRun: () => void
}) {
  const tooLong = utf8ByteLength(value) > PII_TEXT_MAX_BYTES
  const phase = pending ? "running" : error ? "error" : result !== undefined ? "complete" : "idle"
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Playground">
      <div className={`${styles.workspace} overflow-hidden rounded-xl border border-input`} data-phase={phase}>
        <div className="flex flex-col gap-4 bg-muted/30 p-4 sm:p-6" aria-live="polite" aria-busy={pending}>
          <div className="flex items-center justify-between gap-3">
            <h4 id="pii-output-label" className="text-sm font-medium">Public message</h4>
            {phase === "complete" ? <Check aria-hidden="true" className="size-5 text-muted-foreground" /> : null}
          </div>
          <div className="max-h-64 min-h-24 overflow-y-auto thin-scrollbar">
            {pending ? <div className="flex min-h-24 flex-col items-center justify-center gap-3 text-center">
              <div className={`${styles.processing} w-full`} aria-hidden="true">
                <span className={styles.packet} /><span className={`${styles.packet} ${styles.packetSecond}`} />
                {[0, 1, 2].map(index => <span key={index} className={styles.filter} style={{ animationDelay: `${index * 180}ms` }}><ListFilter className="size-6" /></span>)}
              </div>
              <p role="status" className="text-sm text-muted-foreground">Filtering on your computer…</p>
            </div>
              : error ? <p role="alert" className="text-sm leading-relaxed text-destructive">{error}</p>
              : result !== undefined ? <output aria-labelledby="pii-output-label" className={`${styles.result} block whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed`}>{result || "The filtered message is empty."}</output>
              : <p className="flex min-h-24 items-center justify-center text-center text-sm leading-relaxed text-muted-foreground">Your filtered text will appear here.</p>}
          </div>
          {phase === "complete" && triggeredFilters !== undefined ? <p data-testid="pii-triggered-filters" className="wrap-anywhere text-sm leading-relaxed text-muted-foreground">
            {triggeredFilters.length ? <>Matched filters: {triggeredFilters.map(filter => filter.name).join(", ")}</> : "No filters matched."}
          </p> : null}
        </div>
        <form className="flex flex-col gap-4 p-4 sm:p-6" onSubmit={event => { event.preventDefault(); if (!pending && !disabled && !tooLong && value.trim()) onRun() }}>
          <label htmlFor="pii-playground-input" className="text-sm font-medium">Original message</label>
          <Textarea aria-describedby="pii-playground-notice" id="pii-playground-input" data-testid="pii-playground-input" value={value} onChange={event => onValueChange(event.target.value)} placeholder="Enter text to test your filters…" className="max-h-64 min-h-28 resize-y overflow-y-auto rounded-sm border-0 bg-transparent p-0 text-base leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent sm:text-base" disabled={pending} />
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || disabled || tooLong || !value.trim()} className="min-h-11 gap-2 px-4" data-testid="pii-playground-run"><Play className="size-4" />{pending ? "Running…" : "Run test"}</Button>
          </div>
          {tooLong ? <p role="alert" className="text-sm text-destructive">Use 1,024 UTF-8 bytes or fewer.</p> : null}
        </form>
      </div>
      <p id="pii-playground-notice" className="text-sm leading-relaxed text-muted-foreground">We don’t store this message. It is sent to your computer for testing.</p>
    </section>
  )
}
