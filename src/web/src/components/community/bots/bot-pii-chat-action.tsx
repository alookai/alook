"use client"

import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useStartBotChat } from "@/hooks/community/use-start-bot-chat"

export function BotPiiChatAction({ botId }: { botId: string }) {
  const source = useCommunityViewSource(`pii-chat:${botId}`)
  const { start, pending } = useStartBotChat(source)

  return <button type="button" onClick={() => void start({ botId, content: "Help me create and add a PII filter for yourself. First ask me what information I want you to filter.", errorMessage: "Couldn’t start the filter chat. Try again." })} disabled={pending} aria-busy={pending} data-testid="pii-ask-bot" className="min-h-11 w-fit max-w-full rounded-sm text-left text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50">Ask your bot to add a PII filter.</button>
}
