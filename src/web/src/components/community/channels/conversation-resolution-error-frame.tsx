"use client"

import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ConversationResolutionErrorFrame({
  retrying,
  onRetry,
}: {
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
      <div role="alert" className="flex flex-col items-center gap-2">
        <AlertCircle className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Couldn&apos;t verify this conversation</p>
        <p className="text-xs text-muted-foreground">Check your connection and try again.</p>
      </div>
      <Button variant="outline" className="h-11 px-4 sm:h-9" onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </main>
  )
}
