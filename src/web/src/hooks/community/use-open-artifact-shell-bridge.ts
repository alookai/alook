"use client"

import { useCallback, useEffect, useState, type RefObject } from "react"
import { toast } from "sonner"
import {
  buildOpenArtifactHostHello,
  parseTrustedShellMessage,
  type OpenArtifactSavedState,
  type OpenArtifactThemeScheme,
} from "@/lib/community/open-artifact-policy"

export function useOpenArtifactShellBridge({
  frameRef,
  open,
  verifiedOrigin,
  themeScheme,
  onConfirmClose,
  onLeaveLosesWorkChange,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>
  open: boolean
  verifiedOrigin: string | null
  themeScheme: OpenArtifactThemeScheme
  onConfirmClose: () => void
  onLeaveLosesWorkChange: (value: boolean) => void
}) {
  const [shellReady, setShellReady] = useState(false)
  const [shellHelloReceived, setShellHelloReceived] = useState(false)
  const [placeHash, setPlaceHash] = useState<string | null>(null)
  const [savedState, setSavedState] = useState<OpenArtifactSavedState | null>(null)

  const postHostHello = useCallback((origin: string, scheme: OpenArtifactThemeScheme) => {
    frameRef.current?.contentWindow?.postMessage(
      buildOpenArtifactHostHello(scheme),
      origin,
    )
  }, [frameRef])

  useEffect(() => {
    if (!open || !verifiedOrigin) return
    const onMessage = (event: MessageEvent<unknown>) => {
      const parsed = parseTrustedShellMessage(
        event,
        verifiedOrigin,
        frameRef.current?.contentWindow ?? null,
      )
      if (!parsed) return
      switch (parsed.openArtifact) {
        case "shell_hello":
          setShellHelloReceived(true)
          postHostHello(verifiedOrigin, themeScheme)
          break
        case "shell_ready":
          setShellReady(true)
          break
        case "place":
          setPlaceHash(parsed.hash || null)
          break
        case "saved":
          setSavedState(parsed.state)
          onLeaveLosesWorkChange(parsed.leaveLosesWork)
          break
        case "close":
          onConfirmClose()
          break
        case "open_external":
          window.open(parsed.url, "_blank", "noopener,noreferrer")
          break
        case "comment_summon":
          // Upstream Shell emits `comment_summon` as a post-success notification after
          // the OA host already delivered the Ask comment; never re-POST `/comments`.
          toast("Comment posted to conversation")
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [frameRef, onConfirmClose, onLeaveLosesWorkChange, open, postHostHello, themeScheme, verifiedOrigin])

  useEffect(() => {
    if (!open || !verifiedOrigin || !shellHelloReceived) return
    postHostHello(verifiedOrigin, themeScheme)
  }, [open, postHostHello, shellHelloReceived, themeScheme, verifiedOrigin])

  return {
    shellReady,
    placeHash,
    savedState,
  }
}
