"use client"

import { useEffect, useSyncExternalStore } from "react"
import type { QueryClient } from "@tanstack/react-query"

export type MessageSurfaceReceipt = {
  channelId: string
  surfaceKind: "channel" | "thread" | "forum" | "dm"
}

export type ConversationNavigationTarget = {
  href: string
  viewerId: string
  channelId: string
  serverId?: string
  scopeKind: "channel" | "dm"
  expectedSurfaceKind?: MessageSurfaceReceipt["surfaceKind"]
  anchorMessageId?: string
}

export type ConversationNavigationEntry = Pick<
  ConversationNavigationTarget,
  "viewerId" | "channelId" | "scopeKind"
> & { anchorMessageId?: string | null }

type ProofStatus = "warming" | "verified" | "proven" | "forum" | "denied" | "failed"

export type ConversationNavigationProof = {
  epoch: number
  accessEpoch: number
  recoveryAttempt: number
  target: ConversationNavigationTarget
  status: ProofStatus
}

type ConversationNavigationRecovery = (
  accessEpoch: number,
  recoveryAttempt: number,
) => void

type CompletedConversationNavigationEntry = {
  accessEpoch: number
  completionEpoch: number
  entry: ConversationNavigationEntry
}

type ProofStore = {
  nextEpoch: number
  activeEpoch: number
  activeAccessEpoch: number
  activeTarget: ConversationNavigationTarget | null
  proof: ConversationNavigationProof | null
  controller: AbortController | null
  recovery: { epoch: number; restart: ConversationNavigationRecovery } | null
  completedEntries: Map<string, CompletedConversationNavigationEntry>
  listeners: Set<() => void>
}

const stores = new WeakMap<QueryClient, ProofStore>()

function getStore(queryClient: QueryClient): ProofStore {
  let store = stores.get(queryClient)
  if (!store) {
    store = {
      nextEpoch: 0,
      activeEpoch: 0,
      activeAccessEpoch: 0,
      activeTarget: null,
      proof: null,
      controller: null,
      recovery: null,
      completedEntries: new Map(),
      listeners: new Set(),
    }
    stores.set(queryClient, store)
  }
  return store
}

function conversationNavigationEntryKey(target: ConversationNavigationEntry) {
  return JSON.stringify([
    target.viewerId,
    target.scopeKind,
    target.channelId,
    target.anchorMessageId ?? null,
  ])
}

function sameConversationNavigationScope(
  a: ConversationNavigationEntry,
  b: ConversationNavigationEntry,
) {
  return a.viewerId === b.viewerId
    && a.scopeKind === b.scopeKind
    && a.channelId === b.channelId
}

function publish(store: ProofStore, proof: ConversationNavigationProof | null) {
  store.proof = proof
  for (const listener of store.listeners) listener()
}

export function beginConversationNavigationProof(
  queryClient: QueryClient,
  target: ConversationNavigationTarget,
  accessEpoch: number,
  recoveryAttempt = 0,
): { epoch: number; signal: AbortSignal } {
  const store = getStore(queryClient)
  store.controller?.abort()
  const controller = new AbortController()
  const epoch = ++store.nextEpoch
  store.activeEpoch = epoch
  store.activeAccessEpoch = accessEpoch
  store.activeTarget = target
  store.controller = controller
  store.recovery = null
  for (const [key, completed] of store.completedEntries) {
    if (completed.accessEpoch !== accessEpoch) store.completedEntries.delete(key)
  }
  const completed = store.completedEntries.get(conversationNavigationEntryKey(target))
    ?.accessEpoch === accessEpoch
  publish(store, {
    epoch,
    accessEpoch,
    recoveryAttempt,
    target,
    status: completed ? "proven" : "warming",
  })
  return { epoch, signal: controller.signal }
}

export function registerConversationNavigationRecovery(
  queryClient: QueryClient,
  epoch: number,
  restart: ConversationNavigationRecovery,
) {
  const store = getStore(queryClient)
  if (store.activeEpoch !== epoch || store.proof?.epoch !== epoch) return false
  store.recovery = { epoch, restart }
  return true
}

export function recoverConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
  accessEpoch: number,
) {
  const store = getStore(queryClient)
  const proof = store.proof
  const recovery = store.recovery
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
  const store = getStore(queryClient)
  return store.activeEpoch === epoch && store.activeAccessEpoch === accessEpoch
}

export function recordConversationNavigationReceipt(
  queryClient: QueryClient,
  receipt: MessageSurfaceReceipt,
  accessEpoch: number,
  epoch?: number,
): boolean {
  const store = getStore(queryClient)
  const proof = store.proof
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
  const nextProof = {
    ...proof,
    status: receipt.surfaceKind === "forum" ? "forum" : "verified",
  } as ConversationNavigationProof
  if (nextProof.status === "forum") {
    store.completedEntries.set(
      conversationNavigationEntryKey(nextProof.target),
      {
        accessEpoch: nextProof.accessEpoch,
        completionEpoch: nextProof.epoch,
        entry: nextProof.target,
      },
    )
  }
  publish(store, nextProof)
  return true
}

export function commitConversationNavigationProof(
  queryClient: QueryClient,
  channelId: string,
  accessEpoch: number,
) {
  const store = getStore(queryClient)
  const proof = store.proof
  if (
    proof?.status !== "verified" ||
    proof.target.channelId !== channelId ||
    proof.accessEpoch !== accessEpoch
  ) return false
  return commitConversationNavigationEntry(queryClient, proof.target, accessEpoch)
}

export function commitConversationNavigationEntry(
  queryClient: QueryClient,
  entry: ConversationNavigationEntry,
  accessEpoch: number,
) {
  const store = getStore(queryClient)
  const key = conversationNavigationEntryKey(entry)
  store.completedEntries.set(
    key,
    { accessEpoch, completionEpoch: store.activeEpoch, entry },
  )
  const proof = store.proof
  if (
    !proof
    || proof.accessEpoch !== accessEpoch
    || conversationNavigationEntryKey(proof.target) !== key
  ) return false
  if (proof.status === "proven" || proof.status === "forum") return true
  if (proof.status !== "verified") return false
  publish(store, { ...proof, status: "proven" })
  return true
}

export function commitConversationNavigationPublication(
  queryClient: QueryClient,
  entry: Omit<ConversationNavigationEntry, "anchorMessageId">,
  accessEpoch: number,
  publication: {
    requestedAnchorMessageId: string | null
    coveredAnchorMessageIds?: readonly string[]
  },
) {
  commitConversationNavigationEntry(queryClient, {
    ...entry,
    anchorMessageId: publication.requestedAnchorMessageId ?? undefined,
  }, accessEpoch)
  for (const anchorMessageId of publication.coveredAnchorMessageIds ?? []) {
    commitConversationNavigationEntry(queryClient, {
      ...entry,
      anchorMessageId,
    }, accessEpoch)
  }
}

export function failConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
  accessEpoch: number,
  definitive: boolean,
) {
  const store = getStore(queryClient)
  const proof = store.proof
  if (proof?.epoch !== epoch || proof.accessEpoch !== accessEpoch) return
  if (!definitive && proof.status === "proven") return
  if (definitive) {
    for (const [key, completed] of store.completedEntries) {
      if (sameConversationNavigationScope(completed.entry, proof.target)) {
        store.completedEntries.delete(key)
      }
    }
    store.controller?.abort()
    store.activeEpoch = ++store.nextEpoch
    store.recovery = null
  }
  publish(store, { ...proof, status: definitive ? "denied" : "failed" })
}

function consumeConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
) {
  const store = getStore(queryClient)
  if (store.proof?.epoch !== epoch) return
  store.recovery = null
  publish(store, null)
}

export function cancelConversationNavigationProof(
  queryClient: QueryClient,
  epoch: number,
) {
  const store = getStore(queryClient)
  if (store.activeEpoch !== epoch) return
  store.controller?.abort()
  store.controller = null
  store.recovery = null
  store.activeEpoch = ++store.nextEpoch
  store.activeTarget = null
  publish(store, null)
}

export function cancelActiveConversationNavigationProof(queryClient: QueryClient) {
  const store = getStore(queryClient)
  if (!store.proof) return false
  cancelConversationNavigationProof(queryClient, store.activeEpoch)
  return true
}

export function getConversationNavigationProof(
  queryClient: QueryClient,
): ConversationNavigationProof | null {
  return getStore(queryClient).proof
}

export function getCompletedConversationNavigationEntryEpoch(
  queryClient: QueryClient,
  target: Pick<ConversationNavigationTarget, "viewerId" | "channelId" | "scopeKind">
    & { anchorMessageId: string | null },
  accessEpoch: number,
): number | null {
  const store = getStore(queryClient)
  const completed = store.completedEntries.get(
    conversationNavigationEntryKey(target),
  )
  if (completed?.accessEpoch !== accessEpoch) return null
  const proof = store.proof
  if (proof) {
    return (proof.status === "proven" || proof.status === "forum")
      && proof.accessEpoch === accessEpoch
      && sameConversationNavigationScope(proof.target, target)
      ? proof.epoch
      : null
  }
  return store.activeTarget
    && store.activeAccessEpoch === accessEpoch
    && sameConversationNavigationScope(store.activeTarget, target)
    ? completed.completionEpoch
    : null
}

export function useConversationNavigationGate(
  queryClient: QueryClient,
  viewerId: string,
  channelId: string,
  accessEpoch: number,
): { required: boolean; allowed: boolean } {
  const store = getStore(queryClient)
  const proof = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    () => store.proof,
    () => null,
  )
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
    if (proof.status !== "failed") return
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

  return { required, allowed }
}
