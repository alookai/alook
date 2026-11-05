"use client"

import { createContext, useContext, type ComponentProps, type ReactNode } from "react"
import * as Modal from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

const InlineOnboarding = createContext(false)
export function OnboardingSurface({ children }: { children: ReactNode }) {
  return <InlineOnboarding.Provider value>{children}</InlineOnboarding.Provider>
}
export function Dialog(props: ComponentProps<typeof Modal.Dialog>) {
  const inline = useContext(InlineOnboarding)
  return inline ? <>{props.children}</> : <Modal.Dialog {...props} />
}
export function DialogContent(props: ComponentProps<typeof Modal.DialogContent>) {
  const inline = useContext(InlineOnboarding)
  return inline ? <section data-testid={(props as { "data-testid"?: string })["data-testid"]} aria-busy={props["aria-busy"]} className="w-full min-w-0">{props.children}</section> : <Modal.DialogContent {...props} />
}
export function DialogTitle(props: ComponentProps<typeof Modal.DialogTitle>) {
  const inline = useContext(InlineOnboarding)
  return inline ? <h2 data-slot="dialog-title" className={cn("text-lg font-semibold text-foreground", props.className)}>{props.children}</h2> : <Modal.DialogTitle {...props} />
}
export function DialogDescription(props: ComponentProps<typeof Modal.DialogDescription>) {
  const inline = useContext(InlineOnboarding)
  return inline ? <p className={cn("text-sm text-muted-foreground", props.className)}>{props.children}</p> : <Modal.DialogDescription {...props} />
}
export const DialogHeader = Modal.DialogHeader
export const DialogFooter = Modal.DialogFooter

/** One setup progress bar for every onboarding step (QA #4): steps already
 * done are full, the current step is a half-lit segment, later steps are
 * empty — so nothing reads as finished before the user acts. */
export function OnboardingProgress({ current, total, done = false }: { current: number; total: number; done?: boolean }) {
  return (
    <div data-slot="onboarding-progress" className="flex gap-1.5 pr-8" role="progressbar" aria-label={`Step ${current} of ${total}`}
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : current - 1}>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={cn("h-1.5 flex-1 rounded-full transition-colors",
          index < current - 1 || done ? "bg-primary" : index === current - 1 ? "bg-primary/40" : "bg-muted")} />
      ))}
    </div>
  )
}
