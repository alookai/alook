"use client"

import { useMemo } from "react"
import { useBots, type BotSummary } from "@/hooks/community/use-bots"
import { useCanonicalIdentitiesByUserId } from "@/lib/community-db/projections"
import type { CommunityProfile } from "@/lib/community/models/people"
import { isBotActivityRunning } from "@/lib/community/bot-activity-status"

export type RunningOwnedBot = BotSummary & {
  activityEmoji: string
  activityText: string
}

export function resolveRunningOwnedBots(
  bots: readonly BotSummary[],
  profilesByUserId: ReadonlyMap<string, CommunityProfile>,
): RunningOwnedBot[] {
  return bots.flatMap((bot) => {
    const profile = profilesByUserId.get(bot.id)
    if (!bot.isActive || !isBotActivityRunning(profile?.statusEmoji, profile?.statusText)) return []
    return [{
      ...bot,
      activityEmoji: profile!.statusEmoji!,
      activityText: profile!.statusText!,
    }]
  })
}

export function useRunningOwnedBots() {
  const botsQuery = useBots()
  const botIds = useMemo(() => botsQuery.bots.map((bot) => bot.id), [botsQuery.bots])
  const profilesByUserId = useCanonicalIdentitiesByUserId(botIds, botIds.length > 0)
  const runningBots = useMemo(
    () => resolveRunningOwnedBots(botsQuery.bots, profilesByUserId),
    [botsQuery.bots, profilesByUserId],
  )
  return {
    runningBots,
    initialLoading: botsQuery.isLoading && botsQuery.data === undefined,
    unavailable: botsQuery.isError && botsQuery.data === undefined,
  }
}
