"use client"

import type { ReactNode } from "react"
import { WifiOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"

export function CommunityWsReconnectBoundary({ children }: { children: ReactNode }) {
  const connectionStatus = useCommunityWsStore((state) => state.connectionStatus)
  const reconnectNow = useCommunityWsStore((state) => state.reconnectNow)
  const failed = connectionStatus === "failed"

  return (
    <>
      <div className="contents">{children}</div>
      {failed && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={tid.wsReconnectOverlay}
          data-ws-status={connectionStatus}
          className="fixed bottom-4 right-4 z-50 flex max-w-xs items-center gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-(--e2)"
        >
          <div aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-md bg-warning/10 text-warning">
            <WifiOff className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-sm font-medium">Connection lost</p>
            <p className="text-xs text-muted-foreground">Cached content is still available.</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            data-testid={tid.wsRetry}
            onClick={reconnectNow}
            className="h-11 shrink-0 sm:h-9"
          >
            Retry
          </Button>
        </div>
      )}
    </>
  )
}
