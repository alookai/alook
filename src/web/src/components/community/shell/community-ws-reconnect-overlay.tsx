"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { WifiOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"

export function CommunityWsReconnectBoundary({ children }: { children: ReactNode }) {
  const connectionStatus = useCommunityWsStore((state) => state.connectionStatus)
  const reconnectNow = useCommunityWsStore((state) => state.reconnectNow)
  const blocked = connectionStatus !== "connected"
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!blocked) return
    const dialog = dialogRef.current
    dialog?.focus()
    if (typeof document === "undefined") return
    const keepFocusInDialog = (event: FocusEvent) => {
      if (!dialog || dialog.contains(event.target as Node)) return
      dialog.focus()
    }
    document.addEventListener("focusin", keepFocusInDialog)
    return () => document.removeEventListener("focusin", keepFocusInDialog)
  }, [blocked, connectionStatus])

  return (
    <>
      <div
        className="contents"
        inert={blocked ? true : undefined}
        aria-hidden={blocked ? true : undefined}
      >
        {children}
      </div>
      {blocked && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-ws-reconnect-title"
          tabIndex={-1}
          data-testid={tid.wsReconnectOverlay}
          data-ws-status={connectionStatus}
          className="community-ws-reconnect-overlay fixed inset-0 z-2147483647 grid place-items-center bg-background/60 px-4 outline-none backdrop-blur-sm supports-backdrop-filter:bg-background/45 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
        >
          <div className="flex w-full max-w-xs flex-col items-center text-center text-foreground">
            {connectionStatus === "failed" ? (
              <>
                <div
                  role="alert"
                  aria-live="assertive"
                  aria-atomic="true"
                >
                  <div
                    aria-hidden="true"
                    className="mx-auto mb-4 grid size-10 place-items-center rounded-md bg-destructive/10 text-destructive"
                  >
                    <WifiOff className="size-5" />
                  </div>
                  <h2 id="community-ws-reconnect-title" className="font-heading text-base font-medium">
                    Connection lost
                  </h2>
                </div>
                <Button
                  type="button"
                  data-testid={tid.wsRetry}
                  onClick={reconnectNow}
                  className="mt-4 h-11 w-full sm:h-10 sm:w-auto sm:min-w-24"
                >
                  Retry
                </Button>
              </>
            ) : (
              <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col items-center">
                <div
                  aria-hidden="true"
                  data-connecting-motion=""
                  className="community-ws-connecting-loader mb-4"
                />
                <h2 id="community-ws-reconnect-title" className="font-heading text-base font-medium">
                  Connecting…
                </h2>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
