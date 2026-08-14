"use client"

import { useState } from "react"
import type React from "react"
import { X } from "lucide-react"
import { MAX_STATUS_TEXT_LENGTH } from "@alook/shared"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { EmojiPickerPopover } from "./messages/emoji-picker"
import { STATUS_PRESETS, matchingPreset, hasStatus } from "./status-presets"

export { hasStatus } from "./status-presets"

/**
 * Compact status picker in a Popover, following `EmojiPickerPopover`'s
 * children-as-trigger convention — the caller supplies the trigger element
 * (a status row on `ProfileCard`, a Field-wrapped button in `UserSettings`)
 * and this component owns the popover content: 7 preset rows, a free-text
 * input, an emoji-picker trigger to override the emoji independently, and a
 * clear action.
 */
export function StatusEditor({
  emoji,
  text,
  onChange,
  children,
  side = "bottom",
  align = "start",
}: {
  emoji: string | null
  text: string | null
  onChange: (emoji: string | null, text: string | null) => void
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)
  const [draftText, setDraftText] = useState(text ?? "")

  const setBoth = (o: boolean) => {
    setOpen(o)
    if (o) setDraftText(text ?? "")
  }

  const draftTextTrimmed = () => draftText.trim().slice(0, MAX_STATUS_TEXT_LENGTH)

  const commitText = () => {
    const trimmed = draftTextTrimmed()
    if (trimmed === (text ?? "")) return
    onChange(emoji, trimmed || null)
  }

  const selectedPreset = matchingPreset(emoji, text)

  return (
    <Popover open={open} onOpenChange={setBoth}>
      <PopoverTrigger render={children as React.ReactElement} />
      <PopoverContent side={side} align={align} className="w-64 space-y-2 p-2">
        <div className="space-y-0.5">
          {STATUS_PRESETS.map((preset) => (
            <button
              key={preset.text}
              onClick={() => { onChange(preset.emoji, preset.text); setBoth(false) }}
              className={[
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                selectedPreset === preset ? "bg-accent" : "",
              ].join(" ")}
            >
              <span className="text-base">{preset.emoji}</span>
              <span>{preset.text}</span>
            </button>
          ))}
        </div>
        <Separator />
        <div className="flex items-center gap-2">
          {/* Commit whatever's currently typed in the draft input alongside the
              emoji override — otherwise picking an emoji before blurring/
              pressing Enter on the text field would silently discard it. */}
          <EmojiPickerPopover side="top" align="start" onPick={(e) => onChange(e, draftTextTrimmed() || null)}>
            <button
              className="grid size-8 shrink-0 place-items-center rounded-md border border-border text-base hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Choose emoji"
            >
              {emoji || "🙂"}
            </button>
          </EmojiPickerPopover>
          <Input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return
              commitText()
              setBoth(false)
            }}
            placeholder="Custom status…"
            maxLength={MAX_STATUS_TEXT_LENGTH}
            className="h-8"
          />
        </div>
        {hasStatus(emoji, text) && (
          <button
            onClick={() => { onChange(null, null); setBoth(false) }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
          >
            <X className="size-3.5" /> Clear status
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
