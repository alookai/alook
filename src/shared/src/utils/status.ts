import { OFFLINE_THRESHOLD_MS } from "../constants"
import type { RuntimeStatusType } from "../constants"
export function isOnline(t: string | null | undefined): boolean {
  if (!t) return false
  // D1 datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC without timezone indicator.
  // Append 'Z' if no timezone info to ensure UTC parsing.
  const normalized = t.includes("T") || t.includes("Z") || t.includes("+") ? t : t + "Z"
  const ms = new Date(normalized).getTime()
  return !isNaN(ms) && Date.now() - ms < OFFLINE_THRESHOLD_MS
}
export function formatStatus(s: RuntimeStatusType) { return s === "online" ? "Online" : "Offline" }
export function isPresenceOnline(status: string | null | undefined): boolean {
  return status === "online"
}
export function isPresenceOffline(status: string | null | undefined): boolean {
  return status === "offline"
}
