import type React from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

// A server-rail icon button (home, add-server, etc.) with the active pill + hover tooltip.
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
      {active !== undefined && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full bg-primary transition-all"
          style={{ width: 4, height: active ? 40 : 0 }}
        />
      )}
      <button
        onClick={onClick}
        className={[
          "group grid size-10 shrink-0 place-items-center transition-all duration-150",
          active ? "rounded-xl bg-primary text-primary-foreground" : round ? "rounded-[18px] hover:rounded-xl" : "rounded-xl",
          active ? "" : accent ? "bg-card text-primary" : "bg-card text-foreground",
          active ? "" : "hover:bg-primary hover:text-primary-foreground",
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
