"use client"

import { useContext, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCurrentUser } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { useCommunityRouter } from "@/contexts/community/module-route"
import { useCreateOrGetDm } from "@/hooks/community/mutations"
import { useDmMessageSender } from "@/hooks/community/use-dm-message-sender"
import type { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useUiHandlers } from "@/stores/community"
import { toastApiError } from "@/lib/api/client"

export function useStartBotChat(source: ReturnType<typeof useCommunityViewSource>) {
  const currentUser = useCurrentUser()
  const createOrGetDm = useCreateOrGetDm()
  const { accept } = useDmMessageSender()
  const router = useCommunityRouter()
  const navigation = useContext(CommunityRouteContext)?.navigation
  const uiHandlers = useUiHandlers()
  const inFlight = useRef(false)
  const [pending, setPending] = useAtom(useCreateAtom(false))

  const start = async ({ botId, content, onAccepted, errorMessage }: { botId: string; content: string; onAccepted?: () => void; errorMessage: string }) => {
    if (inFlight.current) return
    const assert = source.capture()
    inFlight.current = true
    setPending(true)
    try {
      assert()
      uiHandlers.cancelPendingNavigation?.()
      const intentCurrent = navigation?.captureIntent() ?? (() => true)
      const data = await createOrGetDm.mutateAsync({ userId: botId, assertActive: assert })
      assert()
      if (!intentCurrent()) throw new DOMException("Retired bot chat navigation", "AbortError")
      const receipt = accept({
        dmId: data.conversation.id,
        content,
        author: { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar },
        assertActive: assert,
      })
      if (!receipt.accepted) throw new Error("Failed to send message")
      onAccepted?.()
      router.push(`/c/me/${data.conversation.id}`)
      await receipt.committed
    } catch (error) {
      toastApiError(error, errorMessage, assert)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return { start, pending }
}
