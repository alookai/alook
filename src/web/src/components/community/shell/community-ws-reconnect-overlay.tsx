"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { LoaderCircle, WifiOff } from "lucide-react"
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
          aria-describedby="community-ws-reconnect-description"
          tabIndex={-1}
          data-testid={tid.wsReconnectOverlay}
          data-ws-status={connectionStatus}
          className="fixed inset-0 z-200 grid place-items-center bg-background/60 px-4 outline-none backdrop-blur-sm supports-backdrop-filter:bg-background/45 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
        >
          <div className="w-full max-w-xs rounded-xl border border-border/60 bg-card p-8 text-center text-card-foreground shadow-(--e2)">
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
                  <p
                    id="community-ws-reconnect-description"
                    className="mt-2 text-sm text-muted-foreground"
                  >
                    We couldn’t reconnect. Check your network and try again.
                  </p>
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
              <div role="status" aria-live="polite" aria-atomic="true">
                <LoaderCircle
                  aria-hidden="true"
                  className="mx-auto mb-4 size-6 text-muted-foreground motion-safe:animate-spin"
                />
                <h2 id="community-ws-reconnect-title" className="font-heading text-base font-medium">
                  Connecting…
                </h2>
                <p
                  id="community-ws-reconnect-description"
                  className="mt-2 text-sm text-muted-foreground"
                >
                  Restoring your live connection. This usually takes a moment.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
