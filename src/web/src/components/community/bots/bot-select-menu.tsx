import type { ComponentProps } from "react"

import { SelectContent, SelectItem } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export function BotSelectMenuContent({
  className,
  ...props
}: ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      className={cn("p-1.5", className)}
      {...props}
    />
  )
}

export function BotSelectMenuItem({
  className,
  ...props
}: ComponentProps<typeof SelectItem>) {
  return (
    <SelectItem
      className={cn("min-h-10 py-2 pr-9 pl-3 leading-snug", className)}
      {...props}
    />
  )
}
