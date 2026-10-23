"use client"

import { useCommunityPreviewNavigation } from "./community-preview-navigation"
import { useCallback, useEffect, useRef, type ComponentProps } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { prepareNavigationMetadata } from "@/lib/community/navigation-metadata"
import { beginNavigationPrefetch } from "@/lib/observability/context"

const absentLifecycle = createStore({ active: true, generation: 0 })
type Props = ComponentProps<"a"> & {
  href: string
  onActivate: () => void
  prefetchMode?: "intent" | "visible"
  active?: boolean
  navigationDisabled?: boolean
}

export function CommunityNavigationLink({
  href, onActivate, prefetchMode = "intent", active = false, navigationDisabled = false,
  onPointerEnter, onFocus, onPointerDown, onClick, ...props
}: Props) {
  const preview = useCommunityPreviewNavigation()
  const registry = useOptionalCommunityDbRegistry()
  const lifecycle = useSelector(registry?.runtime.lifecycle ?? absentLifecycle, state => state)
  const warmed = useRef<{ href: string; registry: typeof registry; generation: number } | null>(null)
  const enabled = lifecycle.active && !navigationDisabled
  const warm = useCallback(() => {
    if (preview || !enabled || active || warmed.current?.href === href
      && warmed.current.registry === registry && warmed.current.generation === lifecycle.generation) return
    warmed.current = { href, registry, generation: lifecycle.generation }
    beginNavigationPrefetch(href)
    if (registry) void prepareNavigationMetadata(registry.queryClient, href, "prefetch")
  }, [active, enabled, href, lifecycle.generation, preview, registry])
  useEffect(() => { if (prefetchMode === "visible") warm() }, [prefetchMode, warm])

  if (preview) return <a {...props} href="#product" aria-current={active ? "page" : props["aria-current"]}
    onClick={event => { event.preventDefault(); if (enabled) onActivate() }} />

  return <a {...props} href={href} aria-current={active ? "page" : props["aria-current"]}
    onPointerEnter={event => { onPointerEnter?.(event); if (!event.defaultPrevented) warm() }}
    onFocus={event => { onFocus?.(event); if (!event.defaultPrevented) warm() }}
    onPointerDown={event => { onPointerDown?.(event); if (!event.defaultPrevented && event.pointerType === "touch") warm() }}
    onClick={event => {
      onClick?.(event)
      if (!enabled) { event.preventDefault(); return }
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
        || props.target && props.target !== "_self" || event.currentTarget.hasAttribute("download")) return
      event.preventDefault()
      onActivate()
    }} />
}
