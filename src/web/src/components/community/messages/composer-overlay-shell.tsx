"use client"

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type HTMLAttributes,
  type ReactNode,
  type SetStateAction,
} from "react"

type ConversationFooterSlot = {
  target: HTMLDivElement | null
  setTarget: Dispatch<SetStateAction<HTMLDivElement | null>>
  selectionActive: boolean
  setSelectionActive: Dispatch<SetStateAction<boolean>>
}

const ConversationFooterSlotContext = createContext<ConversationFooterSlot | null>(null)

export function ConversationFooterSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const [selectionActive, setSelectionActive] = useState(false)
  const value = useMemo(() => ({
    target,
    setTarget,
    selectionActive,
    setSelectionActive,
  }), [selectionActive, target])

  return (
    <ConversationFooterSlotContext.Provider value={value}>
      {children}
    </ConversationFooterSlotContext.Provider>
  )
}

export function useConversationFooterSlot(): ConversationFooterSlot | null {
  return useContext(ConversationFooterSlotContext)
}

export function ComposerOverlayShell({
  children,
  className,
  onOverlapChange,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode
  onOverlapChange: (overlap: number) => void
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const overlapRef = useRef<number | null>(null)
  const footerSlot = useConversationFooterSlot()
  const setFooterTarget = footerSlot?.setTarget
  const bindFooterTarget = useCallback((target: HTMLDivElement | null) => {
    setFooterTarget?.(target)
  }, [setFooterTarget])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const overlay = overlayRef.current
    if (!shell || !overlay) return

    const measure = () => {
      const overlap = Math.max(0, overlay.offsetHeight - shell.offsetHeight)
      if (overlap === overlapRef.current) return
      overlapRef.current = overlap
      onOverlapChange(overlap)
    }

    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [onOverlapChange])

  return (
    <div
      {...props}
      ref={shellRef}
      data-slot="community-composer-shell"
      className={`relative h-[calc(3.75rem+var(--app-safe-area-bottom))] shrink-0 sm:h-15${
        className ? ` ${className}` : ""
      }`}
    >
      <div
        ref={overlayRef}
        data-slot="community-composer-overlay"
        data-selection-active={footerSlot?.selectionActive ? "true" : "false"}
        className={`absolute inset-x-0 bottom-0 z-30${
          footerSlot?.selectionActive ? " h-full" : ""
        }`}
      >
        <div
          aria-hidden={footerSlot?.selectionActive || undefined}
          inert={footerSlot?.selectionActive || undefined}
          className={footerSlot?.selectionActive ? "invisible h-0 overflow-hidden" : undefined}
        >
          {children}
        </div>
        <div
          ref={bindFooterTarget}
          data-slot="community-selection-footer-slot"
          className="pointer-events-none absolute inset-0 z-10"
        />
      </div>
    </div>
  )
}
