import type React from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

export function RailIcon({ label, round, accent, active, onClick, tooltip }: {
  label: React.ReactNode
  round?: boolean
  accent?: boolean
  active?: boolean
  onClick?: () => void
  tooltip?: string
}) {
  const btn = (
    <div className="group relative flex w-full justify-center">
      <span className={[
        "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
        active ? "h-8" : "h-0 group-hover:h-5",
      ].join(" ")} />
      <button
        onClick={onClick}
        className={[
          "grid size-10 shrink-0 place-items-center transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          round ? "rounded-[20px]" : "rounded-xl",
          active
            ? "rounded-2xl bg-primary text-primary-foreground"
            : accent
              ? "border border-dashed border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent hover:rounded-2xl"
              : "bg-secondary text-foreground hover:bg-accent hover:rounded-2xl",
        ].join(" ")}
      >
        {label}
      </button>
    </div>
  )

  if (!tooltip) return btn

  return (
    <Tooltip>
      <TooltipTrigger render={btn} />
      <TooltipContent side="right" sideOffset={8}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
