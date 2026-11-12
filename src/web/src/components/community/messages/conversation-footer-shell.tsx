"use client"

import { useAtom, useCreateAtom, type Atom } from "@tanstack/react-store";
import { createContext, useCallback, useContext, useMemo, type HTMLAttributes, type ReactNode } from "react"
import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { useNativeKeyboard } from "@/hooks/use-native-keyboard"
import { useConversationPresentation } from "@/contexts/view-activity"

type ConversationFooterSlot = {
  target: HTMLDivElement | null
  setTarget: Atom<HTMLDivElement | null>["set"]
  accessoryTarget: HTMLDivElement | null
  setAccessoryTarget: Atom<HTMLDivElement | null>["set"]
  capsuleHeight: number
  selectionActive: boolean
  setSelectionActive: Atom<boolean>["set"]
}

const ConversationFooterSlotContext = createContext<ConversationFooterSlot | null>(null)

export function ConversationFooterSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [accessoryTarget, setAccessoryTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [selectionActive, setSelectionActive] = useAtom(useCreateAtom(false))
  const presented = useConversationPresentation()
  const capsuleHeight = accessoryTarget && presented && !selectionActive ? CONVERSATION_TAIL_SPACE_PX : 0
  const value = useMemo(() => ({
    target,
    setTarget,
    accessoryTarget,
    setAccessoryTarget,
    selectionActive,
    setSelectionActive,
    capsuleHeight,
  }), [accessoryTarget, capsuleHeight, selectionActive, setAccessoryTarget, setSelectionActive, setTarget, target])

  return (
    <ConversationFooterSlotContext.Provider value={value}>
      {children}
    </ConversationFooterSlotContext.Provider>
  )
}

export function useConversationFooterSlot(): ConversationFooterSlot | null {
  return useContext(ConversationFooterSlotContext)
}

export function ConversationFooterShell({
  children,
  className,
  style,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode
}) {
  const keyboard = useNativeKeyboard()
  const presented = useConversationPresentation()
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
      className={`relative z-20 shrink-0 before:pointer-events-none before:absolute before:inset-x-0 before:-top-12 before:bottom-0 before:-z-10 before:bg-[linear-gradient(to_bottom,transparent,var(--background)_32px)] before:content-['']${className ? ` ${className}` : ""}`}
      style={{
        ...style,
        ...(presented && keyboard
          ? { marginBottom: `var(--alook-keyboard-progress, ${typeof style?.marginBottom === "number" ? `${style.marginBottom}px` : style?.marginBottom ?? "0px"})` }
          : {}),
      }}
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
          ? "relative h-15"
          : "hidden"}
      />
    </div>
  )
}
