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
  return inline ? <h2 className={cn("text-lg font-semibold text-foreground", props.className)}>{props.children}</h2> : <Modal.DialogTitle {...props} />
}
export function DialogDescription(props: ComponentProps<typeof Modal.DialogDescription>) {
  const inline = useContext(InlineOnboarding)
  return inline ? <p className={cn("text-sm text-muted-foreground", props.className)}>{props.children}</p> : <Modal.DialogDescription {...props} />
}
export const DialogHeader = Modal.DialogHeader
export const DialogFooter = Modal.DialogFooter
