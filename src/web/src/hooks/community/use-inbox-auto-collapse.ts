"use client"

import { createStore, useSelector, useAtom, useCreateAtom, type Store } from "@tanstack/react-store"
import { useCallback, useEffect } from "react"
import type { QueryClient } from "@tanstack/react-query"
import {
  activateInboxProjectionTicket,
  cancelInboxProjectionTicket,
  registerInboxProjectionTicket,
  type InboxProjectionTicket,
  type InboxRowTarget,
} from "./inbox-read-reservation"

type ProjectionLease = {
  epoch: number
  target: InboxRowTarget
  destinationHref: string
  originHref: string
  previousOpen: boolean
  phase: "submitting" | "committed"
  submitted: boolean
  navigationObserved: boolean
  ticket: InboxProjectionTicket
}

type Options = {
  queryClient: QueryClient
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
}

type ProjectionStore = {
  value: Store<{ lease: ProjectionLease | null; nextEpoch: number }>
}

const projectionStores = new WeakMap<QueryClient, ProjectionStore>()

function projectionStoreFor(queryClient: QueryClient) {
  let store = projectionStores.get(queryClient)
  if (!store) {
    store = { value: createStore<{ lease: ProjectionLease | null; nextEpoch: number }>({ lease: null, nextEpoch: 0 }) }
    projectionStores.set(queryClient, store)
  }
  return store
}

export function useInboxProjectionTarget(queryClient: QueryClient) {
  const store = projectionStoreFor(queryClient)
  return useSelector(store.value, (state) => state.lease?.target ?? null)
}

function publishProjection(store: ProjectionStore, lease: ProjectionLease | null) {
  store.value.setState((state) => ({ ...state, lease }))
}

function allocateProjectionEpoch(store: ProjectionStore) {
  store.value.setState((state) => ({ ...state, nextEpoch: state.nextEpoch + 1 }))
  return store.value.get().nextEpoch
}

function destinationMatches(observed: string | null, expected: string) {
  if (observed === expected) return true
  if (!observed) return false
  const removeHandoff = (href: string) => {
    const [pathname, query = ""] = href.split("?")
    const params = new URLSearchParams(query)
    params.delete("inboxThreadOpener")
    const search = params.toString()
    return `${pathname}${search ? `?${search}` : ""}`
  }
  return removeHandoff(observed) === removeHandoff(expected)
}

export function useInboxAutoCollapse({
  queryClient,
  publishedHref,
  navigationPending,
  pendingHref,
}: Options) {
  const openAtom = useCreateAtom(false)
  const [open, setOpen] = useAtom(openAtom)
  const store = projectionStoreFor(queryClient)
  const projection = useSelector(store.value, (state) => state.lease)
  const projectionTarget = projection?.target ?? null
  const previousPublishedHref = useCreateAtom(publishedHref)

  const commitLease = useCallback((lease: ProjectionLease) => {
    if (store.value.get().lease?.epoch !== lease.epoch) return
    const committed = { ...lease, phase: "committed" as const }
    publishProjection(store, committed)
    activateInboxProjectionTicket(lease.ticket)
  }, [store])

  const rollbackProjection = useCallback((epoch: number, reopen = false) => {
    const lease = store.value.get().lease
    if (!lease || lease.epoch !== epoch) return false
    cancelInboxProjectionTicket(lease.ticket)
    publishProjection(store, null)
    if (reopen) {
      setOpen(lease.previousOpen)
    }
    return true
  }, [store, setOpen])

  const beginProjection = useCallback((
    target: InboxRowTarget,
    destinationHref: string,
  ) => {
    const previous = store.value.get().lease
    if (previous) cancelInboxProjectionTicket(previous.ticket)
    const epoch = allocateProjectionEpoch(store)
    const previousOpen = openAtom.get()
    const ticket = registerInboxProjectionTicket(
      queryClient,
      epoch,
      target,
      (receipt) => {
        const current = store.value.get().lease
        if (!current || current.epoch !== receipt.epoch) return
        publishProjection(store, null)
      },
    )
    const lease: ProjectionLease = {
      epoch,
      target,
      destinationHref,
      originHref: publishedHref,
      previousOpen,
      phase: "submitting",
      submitted: false,
      navigationObserved: false,
      ticket,
    }
    publishProjection(store, lease)
    setOpen(false)
    return epoch
  }, [store, openAtom, queryClient, publishedHref, setOpen])

  const markProjectionSubmitted = useCallback((epoch: number) => {
    const lease = store.value.get().lease
    if (!lease || lease.epoch !== epoch) return false
    const submitted = { ...lease, submitted: true }
    publishProjection(store, submitted)
    if (destinationMatches(publishedHref, lease.destinationHref)) {
      commitLease(submitted)
    }
    return true
  }, [commitLease, publishedHref, store])

  const closeWithoutProjection = useCallback(() => {
    const lease = store.value.get().lease
    if (lease) cancelInboxProjectionTicket(lease.ticket)
    publishProjection(store, null)
    const previousOpen = openAtom.get()
    setOpen(false)
    return previousOpen
  }, [store, openAtom, setOpen])

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next)
  }, [setOpen])

  const isProjected = useCallback((target: InboxRowTarget | null) => {
    if (!target || !projectionTarget) return false
    return projectionTarget.identity === target.identity
      && projectionTarget.fingerprint === target.fingerprint
  }, [projectionTarget])

  const isLatestProjection = useCallback((epoch: number) => (
    store.value.get().lease?.epoch === epoch
  ), [store])

  useEffect(() => {
    const lease = store.value.get().lease
    if (!lease || !lease.submitted || lease.phase !== "submitting") return
    if (destinationMatches(publishedHref, lease.destinationHref)) {
      commitLease(lease)
      return
    }
    if (navigationPending && destinationMatches(pendingHref, lease.destinationHref)) {
      if (!lease.navigationObserved) {
        publishProjection(store, { ...lease, navigationObserved: true })
      }
      return
    }
    // router.pushImmediate() can publish the intent one render before the
    // navigation store exposes pendingHref. Keep the exact tombstone through
    // that gap; a synchronous throw is handled by the caller. Once this lease
    // has observed its pending destination, an idle mismatch is a real cancel.
    if (
      lease.navigationObserved
      || publishedHref !== lease.originHref
      || (navigationPending && pendingHref !== null)
    ) rollbackProjection(lease.epoch)
  }, [commitLease, navigationPending, pendingHref, projection, publishedHref, rollbackProjection, store])

  useEffect(() => {
    const previousHref = previousPublishedHref.get()
    previousPublishedHref.set(publishedHref)
    if (destinationMatches(previousHref, publishedHref) || !openAtom.get()) return
    setOpen(false)
  }, [publishedHref, previousPublishedHref, openAtom, setOpen])

  return {
    open,
    projectionTarget,
    onOpenChange,
    beginProjection,
    markProjectionSubmitted,
    rollbackProjection,
    closeWithoutProjection,
    isProjected,
    isLatestProjection,
  }
}
