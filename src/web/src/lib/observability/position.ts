import type { VirtualListPositionReadReason, VirtualListPositionScope } from "@/lib/community/virtual-list-position"
import { channelHref, normalizeCommunityHref } from "@/lib/community/community-route"
import { actionAttributes, currentPageObservation, navigationForHref } from "./context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "./telemetry"

export type PositionReason = "settled" | "empty" | "target_missing" | "manual_takeover" | "hidden" | "entry_changed" | "retired" | "data_error" | "cancelled" | "superseded" | "origin_changed"
type PositionOwner = "initial" | "late-new" | "target" | "present" | "idle"
export type PositionSnapshotReason = VirtualListPositionReadReason | "not_requested" | "entry_changed" | "viewport_mismatch" | "padding_mismatch" | "anchor_missing" | "accepted"
export type PositionDecision = {
  position_source: "snapshot" | "read_anchor" | "explicit_target" | "new_divider" | "tail" | "unknown"
  position_snapshot: PositionSnapshotReason
}

export function beginPositionObservation(kind: PositionOwner, scope?: VirtualListPositionScope, entry?: object | null) {
  const start = performance.now()
  const generation = telemetryGeneration()
  const eligible = isTelemetryEligible()
  const channel = scope?.proof.channelId ? scope.proof.registry?.collections.channels.get(scope.proof.channelId) : undefined
  const expected = channel ? channel.serverId === null ? `/c/me/${encodeURIComponent(channel.id)}` : channelHref(channel.serverId!, channel.id) : undefined
  const intent = entry && "intent" in entry && typeof entry.intent === "object" && entry.intent !== null ? entry.intent : entry
  const href = intent && "href" in intent && typeof intent.href === "string" ? intent.href
    : typeof window === "undefined" ? undefined : window.location.pathname + window.location.search
  const action = href && (!expected || normalizeCommunityHref(href).pathname === expected)
    ? navigationForHref(href) ?? (typeof window !== "undefined" && window.location.pathname === expected ? currentPageObservation() : undefined) : undefined
  let done = false
  return (reason: PositionReason, decision?: PositionDecision) => {
    if (done) return
    done = true
    if (!eligible || generation !== telemetryGeneration()) return
    emitTelemetry("position.finish", { ...actionAttributes(action), position_owner: kind, position_reason: reason,
      position_source: decision?.position_source ?? "unknown", position_snapshot: decision?.position_snapshot ?? "not_requested",
      start_ms: start, duration_ms: Math.max(0, performance.now() - start),
      target_coverage: reason === "settled" ? "covered" : reason === "target_missing" ? "uncovered" : "unknown" })
  }
}
