"use client"

import { Check, Copy } from "lucide-react"
import { Button } from "./button"

export function PromptCopyPreview({ value, label, onCopy, copied = false, testId }: {
  value: string
  label: string
  onCopy: () => void | Promise<void>
  copied?: boolean
  testId?: string
}) {
  return <div className="relative rounded-lg border border-input bg-muted/30 p-3 pr-14 focus-within:ring-2 focus-within:ring-ring/50">
    <p role="textbox" aria-readonly="true" aria-multiline="true" aria-label={label} tabIndex={0} data-testid={testId} className="line-clamp-2 overflow-hidden break-all text-sm leading-relaxed outline-none select-text" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault()
        const range = document.createRange()
        range.selectNodeContents(event.currentTarget)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }}>{value.replace(/\n+/g, " ")}</p>
    <Button type="button" variant="ghost" size="icon" aria-label="Copy prompt" title={copied ? "Prompt copied" : "Copy prompt"} className="absolute top-2 right-2 size-11" onClick={onCopy}>{copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}</Button>
  </div>
}
