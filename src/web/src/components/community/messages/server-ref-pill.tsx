"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import type React from "react"
import { ServerPill } from "./inline-marks"
import { resolveServerRefBase } from "@/lib/community/channel-ref"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import type { ServerRow } from "@/lib/community-db/schema"
import { communityKeys } from "@/lib/query-keys"
import { useUiHandlers } from "@/stores/community"

export type ServerRefPillView =
  | { kind: "plain"; text: string }
  | { kind: "pill"; label: string; serverId: string }

/**
 * Bare `/server` refs are far more likely to collide with unrelated text
 * (`/tmp`, `/api`, `/docs`) than `/server/channel` — a two-segment ref is
 * distinctive, a one-segment one is not. So the pill only renders when we've
 * positively resolved the slug against canonical `community-db` servers. Any
 * ambiguous or still-loading case falls through to plain text — a load flash
 * turning `/tmp` into a muted pill and back is worse than never highlighting
 * it at all.
 */
export function describeServerRefPillView(args: {
  ref: string
  resolved: { id: string; name: string } | null
}): ServerRefPillView {
  const { ref, resolved } = args
  if (!resolved) return { kind: "plain", text: ref }
  return { kind: "pill", label: resolved.name, serverId: resolved.id }
}

/**
 * Connected shell for a bare `/server` ref — reads directly from `community-db`
 * `servers` so it renders immediately even when no channels are cached yet.
 */
export function ServerRefPill({ children }: { children?: React.ReactNode }) {
  const ref = String(children ?? "")
  const uiHandlers = useUiHandlers()
  const registry = useOptionalCommunityDbRegistry()

  const subscribe = useCallback((notify: () => void) => {
    if (!registry) return () => undefined
    const unsubscribeQuery = registry.queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey
      if (key.length === 4 && key[0] === "community" && key[1] === "db" && key[2] === registry.scopeId && key[3] === "servers") {
        notify()
      }
    })
    const unsubscribeCollection = registry.collections.servers.subscribeChanges(() => notify())
    const unsubscribeLifecycle = registry.runtime.lifecycle.subscribe(() => notify())
    const unsubscribeWs = registry.runtime.ws.subscribe(() => notify())
    return () => {
      unsubscribeQuery()
      unsubscribeCollection.unsubscribe()
      unsubscribeLifecycle.unsubscribe()
      unsubscribeWs.unsubscribe()
    }
  }, [registry])

  const readSnapshot = useCallback((): string => {
    if (!registry || !registry.runtime.lifecycle.get().active) return ""
    const rows = registry.queryClient.getQueryData<ServerRow[]>(
      communityKeys.communityDbCollection(registry.scopeId, "servers"),
    ) ?? [...registry.collections.servers.values()]
    const server = resolveServerRefBase(rows, ref)
    if (!server || registry.runtime.ws.get().revokedServerIds.has(server.id)) return ""
    return `${server.id}\0${server.name}`
  }, [registry, ref])

  const snapshot = useSyncExternalStore(subscribe, readSnapshot, () => "")
  const resolved = useMemo(() => {
    if (!snapshot) return null
    const separator = snapshot.indexOf("\0")
    if (separator < 0) return null
    return { id: snapshot.slice(0, separator), name: snapshot.slice(separator + 1) }
  }, [snapshot])

  const view = describeServerRefPillView({ ref, resolved })

  if (view.kind === "plain") return <>{view.text}</>

  // Navigate via the `navigate` UI-handler, NOT a local `useRouter()`: this pill
  // renders in the memoized Streamdown message tree where `router.push` is a
  // silent no-op (same pre-existing bug as ChannelRefPill). The shell registers
  // `navigate` off its live router.
  return (
    <ServerPill onClick={() => uiHandlers.navigate?.(view.serverId)}>
      {view.label}
    </ServerPill>
  )
}
