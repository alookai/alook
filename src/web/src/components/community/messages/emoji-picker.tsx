"use client"

import { lazy, Suspense, type ReactNode, type ReactElement } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { useCommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"

const EmojiPicker = lazy(() => import("./emoji-picker-interactive"))

export function EmojiPickerPopover(props: {
  children: ReactNode
  onPick: (emoji: string) => void
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  onOpenChange?: (open: boolean) => void
}) {
  const preview = useCommunityPreviewNavigation()
  const [open, setOpen] = useAtom(useCreateAtom(false))
  const setBoth = (value: boolean) => { setOpen(value); props.onOpenChange?.(value) }
  if (preview) return <>{props.children}</>
  return (
    <Popover open={open} onOpenChange={setBoth}>
      <PopoverTrigger render={props.children as ReactElement} />
      <PopoverContent side={props.side ?? "top"} align={props.align ?? "end"} className="w-auto border-none bg-transparent p-0 shadow-none">
        <Suspense fallback={<div role="status" className="rounded-md bg-popover p-3 text-sm text-muted-foreground">Loading emoji…</div>}>
          <EmojiPicker onPick={(emoji) => { props.onPick(emoji); setBoth(false) }} />
        </Suspense>
      </PopoverContent>
    </Popover>
  )
}
