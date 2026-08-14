"use client"

import { useState } from "react"
import type React from "react"
import { useTheme } from "next-themes"
import EmojiMartPicker from "@emoji-mart/react"
import emojiMartData from "@emoji-mart/data"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"

// emoji-mart picker — themed to match light/dark. Uses the native set so it
// renders system emoji without fetching an external SVG sprite (the twitter/twemoji
// set shows "#" placeholders when the CDN sprite can't load).
function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { resolvedTheme } = useTheme()
  return (
    <EmojiMartPicker
      data={emojiMartData}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      set="native"
      previewPosition="none"
      skinTonePosition="none"
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
    />
  )
}

// emoji picker in a shadcn Popover — trigger is the passed child, picker portals out
export function EmojiPickerPopover({
  children, onPick, side = "top", align = "end", onOpenChange,
}: {
  children: React.ReactNode
  onPick: (emoji: string) => void
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const setBoth = (o: boolean) => { setOpen(o); onOpenChange?.(o) }
  return (
    <Popover open={open} onOpenChange={setBoth}>
      <PopoverTrigger render={children as React.ReactElement} />
      <PopoverContent side={side} align={align} className="w-auto border-none bg-transparent p-0 shadow-none">
        <EmojiPicker onPick={(e) => { onPick(e); setBoth(false) }} />
      </PopoverContent>
    </Popover>
  )
}
