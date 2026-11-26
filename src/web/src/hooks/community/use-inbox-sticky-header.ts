"use client"

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react"

type StickyHeaderRegistry = {
  observe: (sticky: HTMLElement, preview: HTMLElement) => () => void
}

const InboxStickyHeaderContext = createContext<StickyHeaderRegistry | null>(null)

function syncHeaderHeight(sticky: HTMLElement, preview: HTMLElement) {
  preview.style.setProperty("--inbox-sticky-header-height", `${sticky.offsetHeight}px`)
}

function createStickyHeaderState() {
  const pairs = new Map<HTMLElement, HTMLElement>()
  let observer: ResizeObserver | null = null

  const ensureObserver = (sticky: HTMLElement) => {
    if (observer) return observer
    const ResizeObserverConstructor = sticky.ownerDocument.defaultView?.ResizeObserver
    if (!ResizeObserverConstructor) return null
    observer = new ResizeObserverConstructor((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const preview = pairs.get(target)
        if (preview) syncHeaderHeight(target, preview)
      }
    })
    return observer
  }

  const registry: StickyHeaderRegistry = {
    observe(sticky, preview) {
      pairs.set(sticky, preview)
      syncHeaderHeight(sticky, preview)
      const ro = ensureObserver(sticky)
      ro?.observe(sticky, { box: "border-box" })
      return () => {
        pairs.delete(sticky)
        ro?.unobserve?.(sticky)
        if (pairs.size === 0 && observer) {
          observer.disconnect()
          observer = null
        }
      }
    },
  }

  return {
    registry,
    disconnect: () => {
      pairs.clear()
      observer?.disconnect()
      observer = null
    },
  }
}

export function InboxStickyHeaderProvider({ children }: { children: ReactNode }) {
  const state = useMemo(() => createStickyHeaderState(), [])

  useEffect(() => () => { state.disconnect() }, [state])

  return createElement(InboxStickyHeaderContext.Provider, { value: state.registry }, children)
}

export function useInboxStickyHeader(
  stickyRef: RefObject<HTMLDivElement | null>,
  previewRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const registry = useContext(InboxStickyHeaderContext)

  useEffect(() => {
    if (!enabled) return
    const sticky = stickyRef.current
    const preview = previewRef.current
    if (!sticky || !preview) return
    if (registry) return registry.observe(sticky, preview)
    syncHeaderHeight(sticky, preview)
    const ResizeObserverConstructor = sticky.ownerDocument.defaultView?.ResizeObserver
    if (!ResizeObserverConstructor) return
    const observer = new ResizeObserverConstructor(() => syncHeaderHeight(sticky, preview))
    observer.observe(sticky, { box: "border-box" })
    return () => observer.disconnect()
  }, [enabled, previewRef, registry, stickyRef])
}
