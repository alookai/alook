import { writeCommunityProfilePatches } from "./profile-seed"
import type { CommunityProfilePatch } from "./models/people"
import { withCommunityCollectionWrites } from "@/lib/community-db/write"
import { commandObservation, currentPageObservation } from "@/lib/observability/context"
import { clearComposerAttachmentSessionsForAccount } from "./composer-attachment-session"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, assertCommunityLiveSnapshotOwnerCurrent, type CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import type { QueryClient } from "@tanstack/react-query"

export function retireCommunityAccount(registry: CommunityDbRegistry) {
  registry.runtime.lifecycle.setState((state) => state.active ? { active: false, generation: state.generation + 1 } : state)
  if (registry.accountId) clearComposerAttachmentSessionsForAccount(registry.accountId)
  registry.runtime.transport.send = null
  void registry.queryClient.cancelQueries()
  registry.queryClient.clear()
}
export function communityRequestOptions(queryClient: QueryClient, token: CommunityLiveSnapshotToken, signal?: AbortSignal, assertActive = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)): ApiRequestOptions & { assertActive: () => void } {
  const registry = getCommunityDbRegistry(queryClient)
  const assertEligible = () => { assertCommunityLiveSnapshotOwnerCurrent(queryClient, token, signal); assertActive() }
  return { observation: commandObservation(token), authenticationAccount: registry?.accountId ?? undefined, signal, assertActive: assertEligible, onUnauthorized: async () => {
    assertEligible()
    if (!registry || getCommunityDbRegistry(queryClient) !== registry || !registry.authenticationView.get().active) return false
    const generation = registry.authenticationView.get().generation
    retireCommunityAccount(registry)
    await registry.retireDisk().catch(() => undefined)
    const viewer = registry.sessionViewer()
    return registry.authenticationView.get().active && registry.authenticationView.get().generation === generation && (viewer === undefined || viewer === null || viewer === registry.accountId)
  } }
}

async function loadCommunityRequest<T>(
  load: (options: ApiRequestOptions) => Promise<T>,
  token: CommunityLiveSnapshotToken,
  signal?: AbortSignal,
  assertCurrent?: () => void,
): Promise<T> {
  const registry = token.registry
  if (!registry) throw new DOMException("Missing community profile owner", "AbortError")
  const assertActive = assertCurrent ?? (() => assertCommunityLiveSnapshotTokenCurrent(registry.queryClient, token, signal))
  await registry.ready
  assertActive()
  await registry.collections.profiles.preload()
  assertActive()
  try {
    const data = await load(communityRequestOptions(registry.queryClient, token, signal, assertActive))
    assertActive()
    return data
  } catch (error) {
    assertActive()
    throw error
  }
}

export function apiFetchCommunity<T>(
  path: string,
  options: ApiRequestOptions | undefined,
  token: CommunityLiveSnapshotToken,
  assertCurrent?: () => void,
): Promise<T> {
  const observation = options?.observation ?? commandObservation(token) ?? { page: currentPageObservation(), reason: "unknown" }
  return loadCommunityRequest((origin) => apiFetch<T>(path, {
    ...options, ...origin, observation, signal: options?.signal,
    assertActive: () => { origin.assertActive?.(); options?.assertActive?.() },
  }), token, options?.signal ?? undefined, assertCurrent)
}

export async function loadAndSeedProfiles<T>(
  load: (options: ApiRequestOptions) => Promise<T>,
  patches: (data: T) => readonly CommunityProfilePatch[],
  registry: CommunityDbRegistry | null,
  signal?: AbortSignal,
  requestToken?: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<T> {
  if (!registry) throw new DOMException("Missing community profile owner", "AbortError")
  const token = requestToken ?? captureCommunityLiveSnapshotToken(registry.queryClient)
  const overlay = registry.runtime.ws.actions
  const overlaySnapshot = overlay.beginPresenceSnapshot()
  const profileSnapshot = token.profileSnapshot
  if (token.registry !== registry) throw new DOMException("Mismatched community profile owner", "AbortError")
  const data = await loadCommunityRequest(load, token, signal)
  const projected = patches(data)
  await writeCommunityProfilePatches(projected, profileSnapshot.registry, {
    snapshot: profileSnapshot,
  })
  assertCommunityLiveSnapshotTokenCurrent(registry.queryClient, token, signal)
  const presence = projected.flatMap((patch) => (
    patch.presence === undefined
      ? []
      : [{ id: patch.id, presence: patch.presence }]
  ))
  if (presence.length > 0) {
    await withCommunityCollectionWrites(registry, () => overlay.seedPresence(
      overlaySnapshot,
      presence.map((patch) => [patch.id, patch.presence] as const),
    ))
    assertCommunityLiveSnapshotTokenCurrent(registry.queryClient, token, signal)
  }
  return data
}

export function apiFetchProfiles<T>(
  path: string,
  patches: (data: T) => readonly CommunityProfilePatch[],
  options: ApiRequestOptions | undefined,
  registry: CommunityDbRegistry | null,
  requestToken?: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<T> {
  return loadAndSeedProfiles(
    (origin) => apiFetch<T>(path, {
      ...options,
      ...origin,
      signal: options?.signal,
      assertActive: () => { origin.assertActive?.(); options?.assertActive?.() },
    }),
    patches,
    registry,
    options?.signal ?? undefined,
    requestToken,
  )
}
