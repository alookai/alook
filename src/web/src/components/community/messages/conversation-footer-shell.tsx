"use client"

import { useAtom, useCreateAtom, type Atom } from "@tanstack/react-store";
import { createContext, useCallback, useContext, useMemo, type HTMLAttributes, type ReactNode } from "react"

type ConversationFooterSlot = {
  target: HTMLDivElement | null
  setTarget: Atom<HTMLDivElement | null>["set"]
  selectionActive: boolean
  setSelectionActive: Atom<boolean>["set"]
}

const ConversationFooterSlotContext = createContext<ConversationFooterSlot | null>(null)

export function ConversationFooterSlotProvider({ children }: { children: ReactNode }) {
const [target, setTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [selectionActive, setSelectionActive] = useAtom(useCreateAtom(false))
  const value = useMemo(() => ({
    target,
    setTarget,
    selectionActive,
    setSelectionActive,
  }), [selectionActive, setSelectionActive, setTarget, target])

  return (
    <ConversationFooterSlotContext.Provider value={value}>
      {children}
    </ConversationFooterSlotContext.Provider>
  )
}

export function useConversationFooterSlot(): ConversationFooterSlot | null {
  return useContext(ConversationFooterSlotContext)
}

/**
 * The single in-flow footer owner for a conversation surface.
 *
 * Composer content grows naturally and the message viewport consumes the
 * remaining height. Selection replaces that content with an explicit
 * one-line footer slot instead of layering another hitbox over the message
 * list.
 */
export function ConversationFooterShell({
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode
}) {
  const footerSlot = useConversationFooterSlot()
  const setFooterTarget = footerSlot?.setTarget
  const bindFooterTarget = useCallback((target: HTMLDivElement | null) => {
    setFooterTarget?.(target)
  }, [setFooterTarget])
  const selectionActive = footerSlot?.selectionActive ?? false

  return (
    <div
      {...props}
      data-slot="community-conversation-footer"
      data-selection-active={selectionActive ? "true" : "false"}
      className={`relative shrink-0${className ? ` ${className}` : ""}`}
    >
      <div
        aria-hidden={selectionActive || undefined}
        inert={selectionActive || undefined}
        className={selectionActive ? "invisible h-0 overflow-hidden" : undefined}
      >
        {children}
      </div>
      <div
        ref={bindFooterTarget}
        data-slot="community-selection-footer-slot"
        className={selectionActive
          ? "relative h-[calc(3.75rem+var(--app-safe-area-bottom))] sm:h-15"
          : "hidden"}
      />
    </div>
  )
}
