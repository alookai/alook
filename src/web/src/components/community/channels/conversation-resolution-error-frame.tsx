"use client"

import { AlertCircle } from "@/components/icons/lucide";
import { tid } from "@/lib/community/testids"
import { Button } from "@/components/ui/button"

export function ConversationResolutionErrorFrame({
  retrying,
  onRetry,
  as: Element = "main",
  title = "Couldn't verify this conversation",
}: {
  retrying: boolean
  onRetry: () => void
  as?: "main" | "div"
  title?: string
}) {
  return (
    <Element data-testid={tid.conversationLoadError} data-slot="conversation-load-error" className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
      <div role="alert" className="flex w-full max-w-sm flex-col items-center gap-2">
        <div data-slot="empty-state-icon" className="mb-1 grid size-14 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><AlertCircle className="size-7" aria-hidden /></div>
        <p className="text-sm leading-snug font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">Check your connection and try again.</p>
      </div>
      <Button data-testid={tid.conversationLoadRetry} variant="outline" className="h-11 min-w-24 px-4 sm:h-9" onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </Element>
  )
}
