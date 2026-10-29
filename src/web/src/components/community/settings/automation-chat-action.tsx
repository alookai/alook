"use client"

import { useBots } from "@/hooks/community/use-bots"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useStartBotChat } from "@/hooks/community/use-start-bot-chat"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"

export function AutomationChatAction({ onAccepted }: { onAccepted?: () => void }) {
  const { bots } = useBots()
  const profiles = useCanonicalProfilesByUserId(bots.map((bot) => bot.id))
  const source = useCommunityViewSource("automation-help")
  const { start, pending } = useStartBotChat(source)
  const bot = bots.find((item) => item.isActive && profiles.get(item.id)?.presence === "online") ?? bots[0]
  if (!bot) return null

  return <button type="button" onClick={() => void start({
    botId: bot.id,
    content: "Read https://alook.ai/agent.md and explain how to use Automation, including access codes, permissions, limits, and CLI commands.",
    onAccepted,
    errorMessage: "Couldn’t start the Automation chat. Try again.",
  })} disabled={pending} aria-busy={pending} data-testid="automation-ask-bot" className="min-h-11 w-fit max-w-full rounded-sm text-left text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50">Ask your bot how to use Automation.</button>
}
