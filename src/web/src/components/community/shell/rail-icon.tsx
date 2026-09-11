import type React from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { RailIndicator } from "./rail-indicator"

export function RailIcon({ label, round, accent, active, onClick, tooltip, testId, onboardingTarget }: {
  label: React.ReactNode
  round?: boolean
  accent?: boolean
  active?: boolean
  onClick?: () => void
  tooltip?: string
  testId?: string
  onboardingTarget?: string
}) {
  const btn = (
    <div
      className="group relative flex w-full justify-center"
      data-onboarding-target={onboardingTarget}
    >
      <RailIndicator active={active} />
      <button
        data-testid={testId}
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
