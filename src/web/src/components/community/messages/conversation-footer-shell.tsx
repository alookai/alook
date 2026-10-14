"use client"

import { useAtom, useCreateAtom, type Atom } from "@tanstack/react-store";
import { createContext, useCallback, useContext, useMemo, type HTMLAttributes, type ReactNode } from "react"
import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"

type ConversationFooterSlot = {
  target: HTMLDivElement | null
  setTarget: Atom<HTMLDivElement | null>["set"]
  accessoryTarget: HTMLDivElement | null
  setAccessoryTarget: Atom<HTMLDivElement | null>["set"]
  selectionActive: boolean
  setSelectionActive: Atom<boolean>["set"]
}

const ConversationFooterSlotContext = createContext<ConversationFooterSlot | null>(null)

export function ConversationFooterSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [accessoryTarget, setAccessoryTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [selectionActive, setSelectionActive] = useAtom(useCreateAtom(false))
  const value = useMemo(() => ({
    target,
    setTarget,
    accessoryTarget,
    setAccessoryTarget,
    selectionActive,
    setSelectionActive,
  }), [accessoryTarget, selectionActive, setAccessoryTarget, setSelectionActive, setTarget, target])

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
  const setAccessoryTarget = footerSlot?.setAccessoryTarget
  const bindFooterTarget = useCallback((target: HTMLDivElement | null) => {
    setFooterTarget?.(target)
  }, [setFooterTarget])
  const bindAccessoryTarget = useCallback((target: HTMLDivElement | null) => {
    setAccessoryTarget?.(target)
  }, [setAccessoryTarget])
  const selectionActive = footerSlot?.selectionActive ?? false

  return (
    <div
      {...props}
      data-slot="community-conversation-footer"
      data-selection-active={selectionActive ? "true" : "false"}
      className={`relative shrink-0${className ? ` ${className}` : ""}`}
    >
      <div
        ref={bindAccessoryTarget}
        data-slot="community-composer-accessory-slot"
        style={{ height: CONVERSATION_TAIL_SPACE_PX }}
        className={`pointer-events-none absolute inset-x-0 bottom-full z-20 items-center pl-(--community-composer-inline-start) pr-(--community-composer-inline-end) ${selectionActive ? "hidden" : "flex"}`}
      />
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
