"use client"

import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { beginCommunityProfileSeed } from "@/lib/community/profile-seed"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"

// Hook callbacks and mutateAsync chains can survive unmount. Bind this domain's
// requests to the original provider; never look up a new account as a fallback.
export function useCommunityMutationOrigin() {
  const qc = useQueryClient()
  const registry = useOptionalCommunityDbRegistry()
  return useMemo(() => {
  const begin = () => ({
    token: captureCommunityLiveSnapshotToken(qc),
    profileSnapshot: beginCommunityProfileSeed(registry),
  })
  const assert = (token: ReturnType<typeof begin>["token"]) => {
    if (!registry || getCommunityDbRegistry(qc) !== registry) {
      throw new DOMException("Retired bot mutation owner", "AbortError")
    }
    assertCommunityLiveSnapshotTokenCurrent(qc, token, undefined)
  }
  const assertOwner = (token: ReturnType<typeof begin>["token"]) => {
    const state = registry?.runtime.ws.get(), lifetime = registry?.runtime.lifecycle.get()
    if (!registry || getCommunityDbRegistry(qc) !== registry || token.registry !== registry || token.queryClient !== qc
      || !lifetime?.active || lifetime.generation !== token.ownerGeneration
      || state?.profileViewerId !== token.viewerId || state.profileAccountEpoch !== token.accountEpoch) {
      throw new DOMException("Retired community mutation owner", "AbortError")
    }
  }
  const runWith = async <T,>(token: ReturnType<typeof begin>["token"], load: (options: ApiRequestOptions) => Promise<T>): Promise<T> => {
    assert(token)
    const controller = new AbortController()
    const changed = () => { try { assert(token) } catch { controller.abort() } }
    const subscription = registry!.runtime.lifecycle.subscribe(changed)
    try {
      await registry!.ready
      assert(token)
      const data = await load(communityRequestOptions(qc, token, controller.signal, () => assert(token)))
      assert(token)
      return data
    } catch (error) {
      assert(token)
      throw error
    } finally { subscription.unsubscribe() }
  }
  const request = <T,>(token: ReturnType<typeof begin>["token"], path: string, options?: ApiRequestOptions) => runWith<T>(token, (origin) => apiFetch<T>(path, { ...options, ...origin, signal: options?.signal && origin.signal ? AbortSignal.any([options.signal, origin.signal]) : options?.signal ?? origin.signal, assertActive: () => { origin.assertActive?.(); options?.assertActive?.() } }))
  return {
    registry, begin, assert, assertOwner, request, runWith,
    run: <T,>(load: (options: ApiRequestOptions) => Promise<T>) => runWith(begin().token, load),
    fetch: <T,>(path: string, options?: ApiRequestOptions) => request<T>(begin().token, path, options),
  }
  }, [qc, registry])
}
