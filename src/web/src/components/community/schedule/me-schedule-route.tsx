"use client"

import { useCallback, useMemo, useState } from "react"
import { useCommunityModuleLocation } from "@/contexts/community/module-route"
import { useBots } from "@/hooks/community/use-bots"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useScheduleEvents } from "@/hooks/community/use-schedule"
import { useStartBotChat } from "@/hooks/community/use-start-bot-chat"
import { mapScheduleListResponse } from "@/lib/community/schedule"
import { useUiHandlers } from "@/stores/community"
import {
  getAgendaQueryRange,
  getWeekQueryRange,
  startOfLocalDay,
} from "./schedule-date"
import type {
  ScheduleActor,
  ScheduleViewMode,
} from "./schedule-types"
import { ScheduleWorkspace } from "./schedule-workspace"

const ASK_BOT_SCHEDULE_PROMPT =
  "Help me set up a recurring or one-time schedule for yourself. First ask me what task I want scheduled, when it should run, and which conversation to post in."

export default function MeSchedulePage() {
  const handlers = useUiHandlers()
  const { router } = useCommunityModuleLocation()
  const bots = useBots()
  const source = useCommunityViewSource("schedule-ask-bot")
  const { start: startBotChat, pending: askingBot } = useStartBotChat(source)

  const [view, setView] = useState<ScheduleViewMode>("week")
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfLocalDay(new Date()))
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)

  const queryRange = useMemo(
    () => (view === "week" ? getWeekQueryRange(anchorDate) : getAgendaQueryRange(anchorDate, 30)),
    [anchorDate, view],
  )

  const scheduleQuery = useScheduleEvents(queryRange)

  const avatarByUserId = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const bot of bots.bots) {
      map.set(bot.id, bot.image ?? null)
    }
    return map
  }, [bots.bots])

  const mapped = useMemo(
    () =>
      scheduleQuery.data
        ? mapScheduleListResponse(scheduleQuery.data, avatarByUserId)
        : null,
    [avatarByUserId, scheduleQuery.data],
  )

  const scheduleBots = useMemo<ScheduleActor[]>(() => {
    const byId = new Map<string, ScheduleActor>()
    for (const bot of bots.bots) {
      byId.set(bot.id, {
        id: bot.id,
        name: bot.name,
        kind: "bot",
        avatarUrl: bot.image,
      })
    }
    for (const creator of mapped?.creators ?? []) {
      if (creator.kind !== "bot") continue
      const existing = byId.get(creator.id)
      byId.set(creator.id, {
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        kind: "bot",
        avatarUrl: existing?.avatarUrl ?? creator.avatarUrl,
      })
    }
    return Array.from(byId.values())
  }, [bots.bots, mapped?.creators])

  const handleOpenSourceMessage = useCallback(
    (messageId: string) => {
      handlers.cancelPendingNavigation?.()
      router.push(`/c/messages/${encodeURIComponent(messageId)}`)
    },
    [handlers, router],
  )

  const handleAskBot = useCallback(
    (botId: string) => {
      void startBotChat({
        botId,
        content: ASK_BOT_SCHEDULE_PROMPT,
        errorMessage: "Couldn’t start the schedule chat. Try again.",
      })
    },
    [startBotChat],
  )

  const handleOpenBots = useCallback(() => {
    handlers.cancelPendingNavigation?.()
    router.push("/c/me/bots")
  }, [handlers, router])

  const loadError = scheduleQuery.isError && !scheduleQuery.data
    ? "Couldn’t load your schedule — check your connection and retry."
    : null

  return (
    <ScheduleWorkspace
      view={view}
      onViewChange={setView}
      anchorDate={anchorDate}
      onAnchorDateChange={setAnchorDate}
      selectedBotId={selectedBotId}
      onSelectedBotIdChange={setSelectedBotId}
      bots={scheduleBots}
      occurrences={mapped?.occurrences ?? []}
      loading={scheduleQuery.isPending}
      error={loadError}
      retrying={scheduleQuery.isFetching}
      onRetry={() => {
        void scheduleQuery.refetch()
      }}
      onBack={() => handlers.goBackMobile?.()}
      onOpenSourceMessage={handleOpenSourceMessage}
      onAskBot={handleAskBot}
      askingBot={askingBot}
      onOpenBots={handleOpenBots}
    />
  )
}
