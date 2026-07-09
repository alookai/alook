"use client"

import { BotList } from "@/components/community/bots/bot-list"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useUiHandlers } from "@/stores/community"

export default function MeBotsPage() {
  const bp = useBreakpoint()
  const uiHandlers = useUiHandlers()
  return (
    <BotList
      onBack={bp === "mobile" ? () => uiHandlers.goBackMobile?.() : undefined}
    />
  )
}
