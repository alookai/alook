import type { Presence } from "@/components/community/_types"

/**
 * The single client-side presence-overlay helper.
 *
 * `member.status` / `friend.status` / `dm.status` from the list routes are NOT
 * live presence — the routes hardcode them at fetch time. Real presence only
 * exists by overlaying `useOnlineUserIds()` (the WS-maintained set) on the raw
 * row. Every call site that renders a member / friend / DM row must resolve
 * presence through this one helper so self-handling and key resolution stay
 * consistent instead of drifting per-site.
 *
 * Rules (unified across all sites):
 *   - self → always "online" (the signed-in viewer is present by definition).
 *   - a resolved id present in `onlineUserIds` → "online", else "offline".
 *   - no id → `undefined` (only the ProfileCard path, which tolerates it).
 *
 * Pure functions (no React) so they're unit-testable without a render harness.
 */
export function resolveProfilePresence(
  isSelf: boolean,
  targetUserId: string | undefined,
  onlineUserIds: ReadonlySet<string>,
): Presence | undefined {
  if (isSelf) return "online"
  if (!targetUserId) return undefined
  return onlineUserIds.has(targetUserId) ? "online" : "offline"
}

/**
 * Row-overlay variant for member / friend / DM rows. Normalizes the id key
 * (`userId ?? id`) in ONE place, applies the self → online rule when
 * `currentUserId` is provided, and resolves a missing id to "offline" (the
 * concrete `Presence` these rows require). Delegates to
 * `resolveProfilePresence` so there is a single source of presence logic.
 */
export function resolveRowPresence(
  row: { userId?: string | null; id?: string | null },
  onlineUserIds: ReadonlySet<string>,
  currentUserId?: string,
): Presence {
  const id = row.userId ?? row.id ?? undefined
  const isSelf = !!id && !!currentUserId && id === currentUserId
  return resolveProfilePresence(isSelf, id, onlineUserIds) ?? "offline"
}
