"use client"

import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DmHeaderSkeleton } from "./dm-header"
import { ComposerSkeleton } from "@/components/community/messages/composer"

export function DmRouteErrorFrame({
  onRetry,
  retrying,
  reserveBackSlot = false,
}: {
  onRetry: () => void
  retrying: boolean
  reserveBackSlot?: boolean
}) {
  return (
    <>
      <DmHeaderSkeleton onBack={reserveBackSlot ? () => {} : undefined} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">Couldn&apos;t verify this conversation</p>
            <p className="mt-1 text-xs text-muted-foreground">Check your connection and try again.</p>
          </div>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
        <ComposerSkeleton />
      </main>
    </>
  )
}
