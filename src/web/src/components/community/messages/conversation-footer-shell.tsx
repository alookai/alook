"use client"

import { useAtom, useCreateAtom, type Atom } from "@tanstack/react-store";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from "react"
import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { useNativeKeyboard } from "@/hooks/use-native-keyboard"
import { useConversationPresentation } from "@/contexts/community/conversation-activity"

type ConversationFooterSlot = {
  target: HTMLDivElement | null
  setTarget: Atom<HTMLDivElement | null>["set"]
  accessoryTarget: HTMLDivElement | null
  setAccessoryTarget: Atom<HTMLDivElement | null>["set"]
  overlayHeight: number
  setOverlayHeight: Atom<number>["set"]
  selectionActive: boolean
  setSelectionActive: Atom<boolean>["set"]
}

const ConversationFooterSlotContext = createContext<ConversationFooterSlot | null>(null)

export function ConversationFooterSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [accessoryTarget, setAccessoryTarget] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [overlayHeight, setOverlayHeight] = useAtom(useCreateAtom(0))
  const [selectionActive, setSelectionActive] = useAtom(useCreateAtom(false))
  const value = useMemo(() => ({
    target,
    setTarget,
    accessoryTarget,
    setAccessoryTarget,
    selectionActive,
    setSelectionActive,
    overlayHeight,
    setOverlayHeight,
  }), [accessoryTarget, overlayHeight, setOverlayHeight, selectionActive, setAccessoryTarget, setSelectionActive, setTarget, target])

  return (
    <ConversationFooterSlotContext.Provider value={value}>
      {children}
    </ConversationFooterSlotContext.Provider>
  )
}

export function useConversationFooterSlot(): ConversationFooterSlot | null {
  return useContext(ConversationFooterSlotContext)
}

/** The composer overlays the rail so messages remain visible through its empty gutters.
 * Its measured height also reserves tail space; selection keeps an in-flow footer.
 */
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
  const rootRef = useRef<HTMLDivElement>(null)
  const setOverlayHeight = footerSlot?.setOverlayHeight
  const setFooterTarget = footerSlot?.setTarget
  const setAccessoryTarget = footerSlot?.setAccessoryTarget
  const bindFooterTarget = useCallback((target: HTMLDivElement | null) => {
    setFooterTarget?.(target)
  }, [setFooterTarget])
  const bindAccessoryTarget = useCallback((target: HTMLDivElement | null) => {
    setAccessoryTarget?.(target)
  }, [setAccessoryTarget])
  const selectionActive = footerSlot?.selectionActive ?? false
  const overlay = !!footerSlot && presented && !selectionActive
  const overlayHeight = overlay ? footerSlot.overlayHeight : 0
  useLayoutEffect(() => {
    if (!setOverlayHeight) return
    const root = rootRef.current
    if (!overlay || !root) {
      setOverlayHeight(0)
      return
    }
    const measure = () => setOverlayHeight(root.getBoundingClientRect().height)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(root)
    return () => {
      observer?.disconnect()
      setOverlayHeight(0)
    }
  }, [overlay, setOverlayHeight])

  return (
    <div
      {...props}
      ref={rootRef}
      data-slot="community-conversation-footer"
      data-selection-active={selectionActive ? "true" : "false"}
      className={`relative z-20 shrink-0 ${overlay ? "pointer-events-none" : ""}${className ? ` ${className}` : ""}`}
      style={{
        ...style,
        ...(overlay ? { marginTop: -overlayHeight } : {}),
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
