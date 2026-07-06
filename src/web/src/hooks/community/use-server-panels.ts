"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { InviteRow, AuditEntry } from "@/components/community/_types"

/**
 * Fetches the invite list surfaced in the settings tab. The API returns raw
 * rows; we transform to the display shape here so consumers get render-ready
 * cache entries (matching the old context's `InviteRow` mapping).
 */
type RawInvite = {
  id: string
  token: string
  maxUses: number | null
  uses: number
  expiresAt: string | null
  createdAt: string
  creatorId: string | null
  creatorName: string | null
}

export type InvitesResponse = { invites: InviteRow[] }

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_INVITES: readonly InviteRow[] = Object.freeze([])
const EMPTY_AUDIT_ENTRIES: readonly AuditEntry[] = Object.freeze([])

export const invitesQueryFn = (serverId: string) => async (): Promise<InvitesResponse> => {
  const data = await apiFetch<{ invites: RawInvite[] }>(
    `/api/community/servers/${serverId}/invites`,
  )
  const invites: InviteRow[] = data.invites.map((i) => ({
    code: i.token,
    uses: i.uses,
    maxUses: i.maxUses,
    expiresAt: i.expiresAt,
    by: i.creatorName ?? "Unknown",
    creatorId: i.creatorId,
  }))
  return { invites }
}

/**
 * Only surfaces the invite list inside the admin settings tab. Non-admins
 * never see the data — pass `isAdmin=false` to skip the fetch. The server
 * endpoint allows any member (no 4xx), but firing it for members who can't
 * see the UI is wasted bandwidth.
 */
export function useInvites(
  serverId: string | null,
  isAdmin: boolean = true,
): UseQueryResult<InvitesResponse> & { invites: InviteRow[] } {
  const enabled = !!serverId && isAdmin
  const query = useQuery({
    queryKey: enabled ? communityKeys.invites(serverId!) : communityKeys.invites("__none__"),
    queryFn: enabled
      ? invitesQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    invites: query.data?.invites ?? (EMPTY_INVITES as InviteRow[]),
  }
}

/**
 * Fetches paginated audit-log entries. This hook returns the first page only;
 * the settings tab doesn't currently virtualise it — a future step can swap
 * this to `useInfiniteQuery` if larger pages are needed.
 */
type RawAuditRow = {
  log: { action: string; targetType: string; targetId: string; createdAt: string }
  actor: { name: string | null } | null
}

export type AuditLogResponse = { entries: AuditEntry[] }

export const auditLogQueryFn = (serverId: string) => async (): Promise<AuditLogResponse> => {
  const data = await apiFetch<{ entries: RawAuditRow[] }>(
    `/api/community/servers/${serverId}/audit-log`,
  )
  const entries: AuditEntry[] = data.entries.map((e) => ({
    actor: e.actor?.name ?? "System",
    action: e.log.action.replace(/_/g, " "),
    target: e.log.targetType,
    createdAt: e.log.createdAt,
  }))
  return { entries }
}

/**
 * The audit-log endpoint is admin-only (returns 403 for regular members).
 * Every server switch would otherwise fire two 403s (retry=1) for non-admin
 * members. Pass `isAdmin` to gate the fetch; the settings tab that renders
 * this data is admin-only anyway.
 */
export function useAuditLog(
  serverId: string | null,
  isAdmin: boolean = true,
): UseQueryResult<AuditLogResponse> & { entries: AuditEntry[] } {
  const enabled = !!serverId && isAdmin
  const query = useQuery({
    queryKey: enabled ? communityKeys.auditLog(serverId!) : communityKeys.auditLog("__none__"),
    queryFn: enabled
      ? auditLogQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    entries: query.data?.entries ?? (EMPTY_AUDIT_ENTRIES as AuditEntry[]),
  }
}

/**
 * Fetches the presence roster for a server — the list of online user ids
 * cached at `communityKeys.presence(serverId)`. WS `presence.update` events
 * live-patch the `useCommunityWsStore.onlineUserIds` set (Step 3); this
 * initial load seeds the same set on server switch.
 */
export type PresenceResponse = { online: string[]; truncated?: boolean; limit?: number }

export const presenceQueryFn = (serverId: string) => () =>
  apiFetch<PresenceResponse>(`/api/community/servers/${serverId}/presence`)

const EMPTY_ONLINE: readonly string[] = Object.freeze([])
export function usePresence(
  serverId: string | null,
): UseQueryResult<PresenceResponse> & { online: readonly string[] } {
  const enabled = !!serverId
  const query = useQuery({
    queryKey: enabled ? communityKeys.presence(serverId!) : communityKeys.presence("__none__"),
    queryFn: enabled
      ? presenceQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    // Reuse a frozen empty array so consumers depending on `online` in a
    // hook dep array don't re-fire on every render while data is loading.
    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
