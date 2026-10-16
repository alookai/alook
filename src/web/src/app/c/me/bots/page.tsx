"use client"

import { BotList } from "@/components/community/bots/bot-list"
import { useUiHandlers } from "@/stores/community"

export default function MeBotsPage() {
  const uiHandlers = useUiHandlers()
  return (
    <BotList
      onBack={() => uiHandlers.goBackMobile?.()}
    />
  )
}
