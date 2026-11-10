"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useStartBotChat } from "@/hooks/community/use-start-bot-chat"

export function BotPiiChatAction({ botId }: { botId: string }) {
  const source = useCommunityViewSource(`pii-chat:${botId}`)
  const { start, pending } = useStartBotChat(source)

  return <Button type="button" onClick={() => void start({ botId, content: "Help me create and add a PII filter for yourself. First ask me what information I want you to filter.", errorMessage: "Couldn’t start the filter chat. Try again." })} disabled={pending} aria-busy={pending} data-testid="pii-ask-bot" className="min-h-11 max-w-full gap-2 whitespace-normal px-4"><Plus aria-hidden="true" className="size-4" />{pending ? "Starting chat…" : "Add filter with bot"}</Button>
}
