"use client"

import Link from "next/link"
import { useLayoutEffect, type ComponentProps } from "react"
import { createStore, useAtom, useCreateAtom, useSelector } from "@tanstack/react-store"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

const absentLifecycle = createStore({ active: true, generation: 0 })

type Props = Omit<ComponentProps<typeof Link>, "href" | "prefetch" | "onNavigate"> & {
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
  const registry = useOptionalCommunityDbRegistry()
  const lifecycle = useSelector(registry?.runtime.lifecycle ?? absentLifecycle, (state) => state)
  const [intent, setIntent] = useAtom(useCreateAtom<{
    href: string
    registry: typeof registry
    generation: number
  } | null>(null))
  useLayoutEffect(() => { setIntent(null) }, [href, registry, lifecycle.generation, setIntent])
  const enabled = lifecycle.active && !navigationDisabled
  const warm = () => {
    if (enabled && !active) setIntent({ href, registry, generation: lifecycle.generation })
  }
  const prefetched = enabled && !active && (prefetchMode === "visible"
    || (intent?.href === href && intent.registry === registry && intent.generation === lifecycle.generation))
  return (
    <Link
      {...props}
      href={href}
      prefetch={prefetched}
      aria-current={active ? "page" : props["aria-current"]}
      onPointerEnter={(event) => { onPointerEnter?.(event); if (!event.defaultPrevented) warm() }}
      onFocus={(event) => { onFocus?.(event); if (!event.defaultPrevented) warm() }}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!event.defaultPrevented && event.pointerType === "touch") warm()
      }}
      onClick={(event) => {
        onClick?.(event)
        if (navigationDisabled || !lifecycle.active) {
          event.preventDefault()
        }
      }}
      onNavigate={(event) => {
        event.preventDefault()
        if (enabled) onActivate()
      }}
    />
  )
}
