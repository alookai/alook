"use client"

import { useEffect } from "react"
import { createStore, useSelector, type Store } from "@tanstack/react-store"
import type { QueryClient } from "@tanstack/react-query"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, type CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityMessageSurfaceReceipt } from "@alook/shared"

export type ConversationNavigationTarget = {
  href: string
  viewerId: string
  channelId: string
  serverId?: string
  scopeKind: "channel" | "dm"
  expectedSurfaceKind?: CommunityMessageSurfaceReceipt["surfaceKind"]
  anchorMessageId?: string
}

type ProofStatus = "warming" | "verified" | "proven" | "forum" | "denied" | "failed"

export type ConversationNavigationProof = {
  epoch: number
  accessEpoch: number
  recoveryAttempt: number
  target: ConversationNavigationTarget
  status: ProofStatus
  manualRetry?: boolean
}

type ConversationNavigationRecovery = (
  accessEpoch: number,
  recoveryAttempt: number,
) => void

type ProofStore = {
  ownerToken: CommunityLiveSnapshotToken | null
  nextEpoch: number
  activeEpoch: number
  activeAccessEpoch: number
  activeTarget: ConversationNavigationTarget | null
  proof: ConversationNavigationProof | null
  controller: AbortController | null
  recovery: { epoch: number; restart: ConversationNavigationRecovery } | null
}

const stores = new WeakMap<QueryClient, Store<ProofStore>>()

function getStore(queryClient: QueryClient): Store<ProofStore> {
  let store = stores.get(queryClient)
  if (!store) {
    store = createStore<ProofStore>({
      ownerToken: null,
      nextEpoch: 0,
      activeEpoch: 0,
      activeAccessEpoch: 0,
      activeTarget: null,
      proof: null,
      controller: null,
      recovery: null,
    })
    stores.set(queryClient, store)
  }
  return store
}

function publish(store: Store<ProofStore>, proof: ConversationNavigationProof | null) {
  store.setState((state) => state.proof === proof ? state : { ...state, proof })
}

export function beginConversationNavigationProof(
  queryClient: QueryClient,
  target: ConversationNavigationTarget,
  accessEpoch: number,
  recoveryAttempt = 0,
): { epoch: number; signal: AbortSignal } {
  const store = getStore(queryClient)
  const current = store.get()
  const ownerToken = captureCommunityLiveSnapshotToken(queryClient, target.channelId)
  if (ownerToken.viewerId !== target.viewerId) throw new DOMException("Conversation viewer does not match owner", "AbortError")
  if (current.activeTarget) {
    const previousKey = communityKeys.channelMessages(current.activeTarget.channelId)
    void queryClient.cancelQueries({ queryKey: previousKey })
    const previousReadKey = communityKeys.channelReadStateSnapshot(current.activeTarget.channelId)
    void queryClient.cancelQueries({ queryKey: previousReadKey })
  }
  current.controller?.abort()
  const controller = new AbortController()
  const epoch = current.nextEpoch + 1
  store.setState((state) => ({
    ...state,
    ownerToken,
    nextEpoch: epoch,
    activeEpoch: epoch,
    activeAccessEpoch: accessEpoch,
    activeTarget: target,
    controller,
    recovery: null,
    proof: { epoch, accessEpoch, recoveryAttempt, target, status: "warming" },
  }))
  return { epoch, signal: controller.signal }
}

export function registerConversationNavigationRecovery(
  queryClient: QueryClient,
  epoch: number,
  restart: ConversationNavigationRecovery,
) {
  const store = getStore(queryClient)
  const current = store.get()
  if (current.activeEpoch !== epoch || current.proof?.epoch !== epoch) return false
  store.setState((state) => ({ ...state, recovery: { epoch, restart } }))
  return true
}

export function recoverConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
  accessEpoch: number,
) {
  const store = getStore(queryClient).get()
  const proof = store.proof
  const recovery = store.recovery
  const owner = store.ownerToken
  if (!owner || getCommunityDbRegistry(queryClient) !== owner.registry || !owner.registry?.runtime.lifecycle.get().active || owner.registry.runtime.lifecycle.get().generation !== owner.ownerGeneration || owner.registry.runtime.ws.get().profileAccountEpoch !== owner.accountEpoch || owner.registry.runtime.ws.get().profileViewerId !== owner.viewerId) return false
  if (
    !proof ||
    proof.epoch !== epoch ||
    proof.status === "denied" ||
    (proof.status !== "failed" && proof.accessEpoch === accessEpoch) ||
    !recovery ||
    recovery.epoch !== epoch
  ) return false
  const recoveryAttempt = proof.accessEpoch === accessEpoch
    ? proof.recoveryAttempt + 1
    : 0
  recovery.restart(accessEpoch, recoveryAttempt)
  return true
}

export function isCurrentConversationNavigation(
  queryClient: QueryClient,
  epoch: number,
  accessEpoch: number,
): boolean {
  const store = getStore(queryClient).get()
  if (!store.ownerToken) return false
  try { assertCommunityLiveSnapshotTokenCurrent(queryClient, store.ownerToken, store.controller?.signal) } catch { return false }
  return store.activeEpoch === epoch && store.activeAccessEpoch === accessEpoch
}

export function recordConversationNavigationReceipt(
  queryClient: QueryClient,
  receipt: CommunityMessageSurfaceReceipt,
  accessEpoch: number,
  epoch?: number,
): boolean {
  const store = getStore(queryClient)
  const proof = store.get().proof
  if (proof && !isCurrentConversationNavigation(queryClient, proof.epoch, accessEpoch)) return false
  if (
    !proof ||
    proof.status === "denied" ||
    (epoch !== undefined && proof.epoch !== epoch) ||
    proof.accessEpoch !== accessEpoch ||
    proof.target.channelId !== receipt.channelId ||
    (proof.target.scopeKind === "dm"
      ? receipt.surfaceKind !== "dm"
      : receipt.surfaceKind === "dm")
  ) {
    return false
  }
  if (proof.status === "proven" || proof.status === "verified" || proof.status === "forum") {
    return true
  }
  publish(store, {
    ...proof,
    status: receipt.surfaceKind === "forum" ? "forum" : "verified",
  })
  return true
}

export function commitConversationNavigationProof(
  queryClient: QueryClient,
  channelId: string,
  accessEpoch: number,
) {
  const store = getStore(queryClient)
  const proof = store.get().proof
  if (proof && !isCurrentConversationNavigation(queryClient, proof.epoch, accessEpoch)) return false
  if (
    proof?.status !== "verified" ||
    proof.target.channelId !== channelId ||
    proof.accessEpoch !== accessEpoch
  ) return false
  publish(store, { ...proof, status: "proven" })
  return true
}

export function failConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
  accessEpoch: number,
  definitive: boolean,
  manualRetry = false,
) {
  const store = getStore(queryClient)
  const current = store.get()
  const proof = current.proof
  if (proof?.epoch !== epoch || proof.accessEpoch !== accessEpoch || !isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
  if (definitive) {
    current.controller?.abort()
    if (current.activeTarget) {
      const readKey = communityKeys.channelReadStateSnapshot(current.activeTarget.channelId)
      void queryClient.cancelQueries({ queryKey: readKey })
    }
  }
  store.setState((state) => ({
    ...state,
    ...(definitive ? {
      nextEpoch: state.nextEpoch + 1,
      activeEpoch: state.nextEpoch + 1,
      recovery: null,
    } : {}),
    proof: { ...proof, status: definitive ? "denied" : "failed", manualRetry },
  }))
}

function consumeConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
) {
  const store = getStore(queryClient)
  if (store.get().proof?.epoch !== epoch) return
  store.setState((state) => ({ ...state, recovery: null, proof: null }))
}

export function cancelConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
) {
  const store = getStore(queryClient)
  const current = store.get()
  if (current.activeEpoch !== epoch) return
  if (current.activeTarget) {
    const queryKey = communityKeys.channelMessages(current.activeTarget.channelId)
    void queryClient.cancelQueries({ queryKey })
    const readKey = communityKeys.channelReadStateSnapshot(current.activeTarget.channelId)
    void queryClient.cancelQueries({ queryKey: readKey })
  }
  current.controller?.abort()
  store.setState((state) => ({
    ...state,
    ownerToken: null,
    controller: null,
    recovery: null,
    nextEpoch: state.nextEpoch + 1,
    activeEpoch: state.nextEpoch + 1,
    activeTarget: null,
    proof: null,
  }))
}

export function cancelActiveConversationNavigationProof(queryClient: QueryClient) {
  const store = getStore(queryClient).get()
  if (!store.controller && !store.activeTarget) return false
  cancelConversationNavigationProof(queryClient, store.activeEpoch)
  return true
}

export function getConversationNavigationProof(
  queryClient: QueryClient,
): ConversationNavigationProof | null {
  return getStore(queryClient).get().proof
}

export function useConversationNavigationGate(
  queryClient: QueryClient,
  viewerId: string,
  channelId: string,
  accessEpoch: number,
): { required: boolean; allowed: boolean; failed: boolean; retry: () => void; target: ConversationNavigationTarget | null } {
  const store = getStore(queryClient)
  const proof = useSelector(store, (state) => state.proof)
  const matching = proof?.target.viewerId === viewerId
    && proof.target.channelId === channelId
  const required = matching === true
  const allowed = !required || (
    proof.accessEpoch === accessEpoch
    && (proof.status === "proven" || proof.status === "forum")
  )

  useEffect(() => {
    if (!proof || !matching || proof.status === "denied") return
    if (proof.accessEpoch !== accessEpoch) {
      recoverConversationNavigationProof(queryClient, proof.epoch, accessEpoch)
      return
    }
    if (proof.status !== "failed" || proof.manualRetry) return
    const delay = Math.min(250 * (2 ** proof.recoveryAttempt), 5_000)
    const timeout = setTimeout(() => {
      recoverConversationNavigationProof(queryClient, proof.epoch, accessEpoch)
    }, delay)
    return () => clearTimeout(timeout)
  }, [accessEpoch, matching, proof, queryClient])

  useEffect(() => {
    if (
      !proof ||
      !matching ||
      (proof.status !== "proven" && proof.status !== "forum") ||
      proof.accessEpoch !== accessEpoch
    ) return
    consumeConversationNavigationProof(queryClient, proof.epoch)
  }, [accessEpoch, matching, proof, queryClient])

  return { required, allowed,
    target: required && isCurrentConversationNavigation(queryClient, proof.epoch, accessEpoch)
      ? proof.target : null,
    failed: required && proof.accessEpoch === accessEpoch && proof.status === "failed" && proof.manualRetry === true,
    retry: () => { if (proof && matching) recoverConversationNavigationProof(queryClient, proof.epoch, accessEpoch) },
  }
}
