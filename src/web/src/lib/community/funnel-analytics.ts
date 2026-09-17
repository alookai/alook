"use client"

import type { CommunityFunnelAnalyticsEvent } from "@alook/shared"
import {
  trackCommunityRuntimeConnected,
  trackFirstAgentReplyPersisted,
  trackInvitedHumanJoined,
} from "@/lib/analytics"

let inFlight: Promise<void> | null = null
let rerun = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

export function decodeCommunityFunnelEvents(value: unknown): CommunityFunnelAnalyticsEvent[] {
  if (!isRecord(value) || !Array.isArray(value.events)) return []
  return value.events.flatMap<CommunityFunnelAnalyticsEvent>((candidate) => {
    if (!isRecord(candidate) || candidate.surface !== "community") return []
    if (
      candidate.event === "runtime_connected"
      && candidate.connection_type === "local_daemon"
      && hasOnlyKeys(candidate, ["event", "surface", "connection_type"])
    ) {
      return [{
        event: "runtime_connected",
        surface: "community",
        connection_type: "local_daemon",
      }]
    }
    if (
      candidate.event === "first_agent_reply_persisted"
      && (candidate.conversation_type === "dm"
        || candidate.conversation_type === "channel"
        || candidate.conversation_type === "thread")
      && hasOnlyKeys(candidate, ["event", "surface", "conversation_type"])
    ) {
      return [{
        event: "first_agent_reply_persisted",
        surface: "community",
        conversation_type: candidate.conversation_type,
      }]
    }
    if (
      candidate.event === "invited_human_joined"
      && hasOnlyKeys(candidate, ["event", "surface"])
    ) {
      return [{ event: "invited_human_joined", surface: "community" }]
    }
    return []
  })
}

function publishCommunityFunnelEvent(event: CommunityFunnelAnalyticsEvent) {
  if (event.event === "runtime_connected") {
    trackCommunityRuntimeConnected()
  } else if (event.event === "first_agent_reply_persisted") {
    trackFirstAgentReplyPersisted(event.conversation_type)
  } else {
    trackInvitedHumanJoined()
  }
}

async function drainOnce() {
  const response = await fetch("/api/community/analytics/funnel-events", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  })
  if (!response.ok) return
  const payload: unknown = await response.json()
  for (const event of decodeCommunityFunnelEvents(payload)) {
    publishCommunityFunnelEvent(event)
  }
}

export function drainCommunityFunnelEvents(): Promise<void> {
  if (inFlight) {
    rerun = true
    return inFlight
  }
  inFlight = (async () => {
    do {
      rerun = false
      try {
        await drainOnce()
      } catch {
        return
      }
    } while (rerun)
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

export function _resetCommunityFunnelAnalyticsForTesting() {
  inFlight = null
  rerun = false
}
