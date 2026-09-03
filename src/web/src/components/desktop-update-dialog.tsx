"use client"

import { useCallback, useEffect, useState } from "react"
import { isDesktop, isTauri, tauriInvoke } from "@alook/shared"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MessageExternalLink } from "@/components/community/messages/message-external-link"

export const DESKTOP_UPDATE_AVAILABLE_EVENT = "desktop://update-available"
export const DESKTOP_PENDING_UPDATE_COMMAND = "desktop_pending_update"
export const DESKTOP_UPDATE_RESPONSE_COMMAND = "desktop_respond_update_prompt"

export interface DesktopUpdateOffer {
  currentVersion: string
  availableVersion: string
  changelogUrl: string
}

export type DesktopUpdateResponse = "update" | "later"
type Unlisten = () => void
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<Unlisten>
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

function expectedChangelogUrl(version: string) {
  return `https://github.com/alookai/alook/releases/tag/v${version}`
}

export function isDesktopUpdateOffer(value: unknown): value is DesktopUpdateOffer {
  if (!value || typeof value !== "object") return false
  const offer = value as Partial<DesktopUpdateOffer>
  return (
    typeof offer.currentVersion === "string" &&
    offer.currentVersion.length > 0 &&
    typeof offer.availableVersion === "string" &&
    offer.availableVersion.length > 0 &&
    offer.changelogUrl === expectedChangelogUrl(offer.availableVersion)
  )
}

function readTauriListen(): Listen | null {
  if (typeof window === "undefined") return null
  const event = (window as unknown as {
    __TAURI__?: { event?: { listen?: Listen } }
  }).__TAURI__?.event
  return event?.listen ? event.listen.bind(event) : null
}

export async function connectDesktopUpdateOffers(
  onOffer: (offer: DesktopUpdateOffer | null) => void,
  options: {
    listen?: Listen | null
    invoke?: Invoke
  } = {},
): Promise<Unlisten> {
  const listen = options.listen === undefined ? readTauriListen() : options.listen
  const invoke = options.invoke ?? tauriInvoke
  if (!listen) throw new Error("window.__TAURI__.event.listen not available")

  let eventReceived = false
  const unlisten = await listen(DESKTOP_UPDATE_AVAILABLE_EVENT, (event) => {
    if (!isDesktopUpdateOffer(event.payload)) return
    eventReceived = true
    onOffer(event.payload)
  })

  try {
    const pending = await invoke(DESKTOP_PENDING_UPDATE_COMMAND)
    if (!eventReceived) onOffer(isDesktopUpdateOffer(pending) ? pending : null)
    return unlisten
  } catch (error) {
    unlisten()
    throw error
  }
}

export function respondToDesktopUpdateOffer(
  offer: DesktopUpdateOffer,
  action: DesktopUpdateResponse,
  invoke: Invoke = tauriInvoke,
) {
  return invoke(DESKTOP_UPDATE_RESPONSE_COMMAND, {
    version: offer.availableVersion,
    action,
  })
}

export function DesktopUpdateDialog() {
  const [offer, setOffer] = useState<DesktopUpdateOffer | null>(null)
  const [responding, setResponding] = useState(false)

  useEffect(() => {
    if (!isTauri() || !isDesktop()) return
    let active = true
    let unlisten: Unlisten | undefined
    void connectDesktopUpdateOffers((nextOffer) => {
      if (!active) return
      setResponding(false)
      setOffer(nextOffer)
    })
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(() => {})
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  const respond = useCallback(async (action: DesktopUpdateResponse) => {
    if (!offer || responding) return
    const version = offer.availableVersion
    setResponding(true)
    try {
      await respondToDesktopUpdateOffer(offer, action)
      setOffer((current) => current?.availableVersion === version ? null : current)
    } catch {
      setResponding(false)
      toast.error("Couldn't respond to the update prompt")
    }
  }, [offer, responding])

  return (
    <Dialog open={offer !== null} onOpenChange={() => {}}>
      {offer ? (
        <DialogContent showCloseButton={false} data-testid="desktop-update-dialog">
          <DialogHeader>
            <DialogTitle>Update Available</DialogTitle>
            <DialogDescription>A newer version of Alook is ready.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-muted/50 p-4 text-sm">
            <dt className="text-muted-foreground">Current version</dt>
            <dd className="text-right font-mono">v{offer.currentVersion}</dd>
            <dt className="text-muted-foreground">New version</dt>
            <dd className="text-right font-mono">v{offer.availableVersion}</dd>
          </dl>
          <MessageExternalLink
            href={offer.changelogUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="desktop-update-changelog"
            className="w-fit text-sm font-medium underline underline-offset-4 hover:text-foreground"
          >
            View changelog
          </MessageExternalLink>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={responding}
              data-testid="desktop-update-later"
              onClick={() => void respond("later")}
            >
              Later
            </Button>
            <Button
              type="button"
              disabled={responding}
              data-testid="desktop-update-confirm"
              onClick={() => void respond("update")}
            >
              Update Alook
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
