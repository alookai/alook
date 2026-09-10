import type { UserWsConnectionPhase } from "@/lib/use-user-ws"
import type { CommunityWsConnectionStatus } from "@/stores/community/ws"

export const COMMUNITY_WS_FAILED_AFTER_MS = 30_000

export type CommunityWsConnectionStatusController = {
  handlePhase: (phase: UserWsConnectionPhase) => void
  reconnectNow: () => void
  dispose: () => void
}

export function createCommunityWsConnectionStatusController({
  publish,
  reconnectTransport,
}: {
  publish: (status: CommunityWsConnectionStatus) => void
  reconnectTransport: () => void
}): CommunityWsConnectionStatusController {
  let failedTimer: ReturnType<typeof setTimeout> | null = null
  let outageActive = false
  let hasAuthenticated = false
  let disposed = false

  const clearTimers = () => {
    if (failedTimer !== null) clearTimeout(failedTimer)
    failedTimer = null
  }

  const armFailedTimer = () => {
    failedTimer = setTimeout(() => {
      failedTimer = null
      if (!disposed && outageActive) publish("failed")
    }, COMMUNITY_WS_FAILED_AFTER_MS)
  }

  const handlePhase = (phase: UserWsConnectionPhase) => {
    if (disposed) return
    if (phase === "authenticated") {
      hasAuthenticated = true
      outageActive = false
      clearTimers()
      publish("connected")
      return
    }
    if (phase === "suspended") {
      outageActive = false
      clearTimers()
      publish("connected")
      return
    }
    if (!hasAuthenticated) {
      outageActive = false
      clearTimers()
      publish("connected")
      return
    }
    if (outageActive) return
    outageActive = true
    publish("reconnecting")
    armFailedTimer()
  }

  const reconnectNow = () => {
    if (disposed) return
    clearTimers()
    outageActive = hasAuthenticated
    publish(hasAuthenticated ? "reconnecting" : "connected")
    if (hasAuthenticated) armFailedTimer()
    reconnectTransport()
  }

  const dispose = () => {
    disposed = true
    outageActive = false
    clearTimers()
  }

  return { handlePhase, reconnectNow, dispose }
}
