"use client"

import type { ReactNode } from "react"
import { WifiOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"

export function CommunityWsReconnectBoundary({ children }: { children: ReactNode }) {
  const connectionStatus = useCommunityWsStore((state) => state.connectionStatus)
  const reconnectNow = useCommunityWsStore((state) => state.reconnectNow)
  const disconnected = connectionStatus !== "connected"

  return (
    <>
      <div className="contents">
        {children}
      </div>
      {disconnected && (
        <div
          data-testid={tid.wsReconnectOverlay}
          data-ws-status={connectionStatus}
          className="community-ws-reconnect-overlay pointer-events-none fixed inset-x-0 top-3 z-2147483647 flex justify-center px-4"
        >
          <div className="pointer-events-auto flex min-h-10 items-center gap-2 rounded-full border bg-background/95 px-3 text-sm text-foreground shadow-md backdrop-blur-sm">
            <WifiOff aria-hidden="true" className="size-4 text-muted-foreground" />
            {connectionStatus === "failed" ? (
              <>
                <span role="alert" aria-live="assertive">Realtime unavailable</span>
                <Button
                  type="button"
                  data-testid={tid.wsRetry}
                  onClick={reconnectNow}
                  size="sm"
                  variant="ghost"
                  className="h-8 rounded-full px-3"
                >
                  Retry
                </Button>
              </>
            ) : (
              <span role="status" aria-live="polite">Reconnecting…</span>
            )}
          </div>
        </div>
      )}
    </>
  )
}
