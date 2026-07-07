"use client"

import { useEffect, useMemo } from "react"
import { useBots } from "@/hooks/community/use-bots"
import { useMachines } from "@/hooks/community/use-machines"
import { useCommunityWsStore } from "@/stores/community/ws"

/**
 * Bridge: derive own-bot presence from `useMachines()` + `useBots()` and seed
 * it into the community WS store's `onlineBotUserIds` set.
 *
 * Why a store bridge instead of per-consumer overlay: bots pass as users at
 * every user-facing surface. Every consumer (DM sidebar, friends page, mention
 * popover, profile card, member list) already reads presence via
 * `useOnlineUserIds()`. Making bot presence flow through the same store means
 * those consumers need zero code changes — the union hook returns
 * human-online ∪ bot-online transparently.
 *
 * The only reason human vs bot presence exists as two writes is that the
 * underlying signals are different:
 *   - human user: tab open → user WS DO holds a connection → `presence.update`.
 *   - own bot:   daemon on the bound machine is connected → `machine.status`.
 * We can't collapse those into one signal, but we CAN collapse the read path.
 *
 * Mount this hook once at the top of the community subtree (see the
 * `me/layout.tsx` bridge point) — subsequent renders just seed / no-op.
 */
export function useBotPresenceBridge(): void {
  const { bots } = useBots()
  const { machines } = useMachines()
  const hydrateBotPresence = useCommunityWsStore((s) => s.hydrateBotPresence)

  const onlineBotIds = useMemo(() => {
    // Fast-path: no bots → empty. Avoid iterating machines when there's nothing
    // to correlate.
    if (bots.length === 0) return [] as string[]
    const onlineMachineIds = new Set(
      machines.filter((m) => m.status === "online").map((m) => m.id),
    )
    const out: string[] = []
    for (const b of bots) {
      if (onlineMachineIds.has(b.machineId)) out.push(b.id)
    }
    return out
  }, [bots, machines])

  useEffect(() => {
    hydrateBotPresence(onlineBotIds)
  }, [onlineBotIds, hydrateBotPresence])
}
