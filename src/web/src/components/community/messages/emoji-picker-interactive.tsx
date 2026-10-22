"use client"

import { useTheme } from "next-themes"
import EmojiMartPicker from "@emoji-mart/react"
import emojiMartData from "@emoji-mart/data"

// emoji-mart picker — themed to match light/dark. Uses the native set so it
// renders system emoji without fetching an external SVG sprite (the twitter/twemoji
// set shows "#" placeholders when the CDN sprite can't load).
export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
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
