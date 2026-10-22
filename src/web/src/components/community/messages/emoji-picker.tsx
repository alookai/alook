"use client"

import type { ReactNode } from "react"
import dynamic from "next/dynamic"
import { useCommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"

const InteractiveEmojiPickerPopover = dynamic(() => import("./emoji-picker-interactive"))

export function EmojiPickerPopover(props: {
  children: ReactNode
  onPick: (emoji: string) => void
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  onOpenChange?: (open: boolean) => void
}) {
  const preview = useCommunityPreviewNavigation()
  return preview ? <>{props.children}</> : <InteractiveEmojiPickerPopover {...props} />
}
