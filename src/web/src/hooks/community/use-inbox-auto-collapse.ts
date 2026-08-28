"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
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
  previousOpen: boolean
  phase: "submitting" | "committed"
  submitted: boolean
  ticket: InboxProjectionTicket
}

type Options = {
  queryClient: QueryClient
  publishedHref: string
  navigationPending: boolean
  pendingHref: string | null
}

type ProjectionStore = {
  current: ProjectionLease | null
  listeners: Set<() => void>
  nextEpoch: number
}

const projectionStores = new WeakMap<QueryClient, ProjectionStore>()

function projectionStoreFor(queryClient: QueryClient) {
  let store = projectionStores.get(queryClient)
  if (!store) {
    store = { current: null, listeners: new Set(), nextEpoch: 0 }
    projectionStores.set(queryClient, store)
  }
  return store
}

function publishProjection(store: ProjectionStore, lease: ProjectionLease | null) {
  store.current = lease
  for (const listener of store.listeners) listener()
}

function allocateProjectionEpoch(store: ProjectionStore) {
  store.nextEpoch += 1
  return store.nextEpoch
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
  const [open, setOpen] = useState(false)
  const store = projectionStoreFor(queryClient)
  const projection = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    () => store.current,
    () => store.current,
  )
  const openRef = useRef(open)

  const commitLease = useCallback((lease: ProjectionLease) => {
    if (store.current?.epoch !== lease.epoch) return
    const committed = { ...lease, phase: "committed" as const }
    publishProjection(store, committed)
    activateInboxProjectionTicket(lease.ticket)
  }, [store])

  const rollbackProjection = useCallback((epoch: number, reopen = false) => {
    const lease = store.current
    if (!lease || lease.epoch !== epoch) return false
    cancelInboxProjectionTicket(lease.ticket)
    publishProjection(store, null)
    if (reopen) {
      openRef.current = lease.previousOpen
      setOpen(lease.previousOpen)
    }
    return true
  }, [store])

  const beginProjection = useCallback((
    target: InboxRowTarget,
    destinationHref: string,
  ) => {
    const previous = store.current
    if (previous) cancelInboxProjectionTicket(previous.ticket)
    const epoch = allocateProjectionEpoch(store)
    const previousOpen = openRef.current
    const ticket = registerInboxProjectionTicket(
      queryClient,
      epoch,
      target,
      (receipt) => {
        const current = store.current
        if (!current || current.epoch !== receipt.epoch) return
        publishProjection(store, null)
      },
    )
    const lease: ProjectionLease = {
      epoch,
      target,
      destinationHref,
      previousOpen,
      phase: "submitting",
      submitted: false,
      ticket,
    }
    publishProjection(store, lease)
    openRef.current = false
    setOpen(false)
    return epoch
  }, [queryClient, store])

  const markProjectionSubmitted = useCallback((epoch: number) => {
    const lease = store.current
    if (!lease || lease.epoch !== epoch) return false
    const submitted = { ...lease, submitted: true }
    publishProjection(store, submitted)
    if (destinationMatches(publishedHref, lease.destinationHref)) {
      commitLease(submitted)
    }
    return true
  }, [commitLease, publishedHref, store])

  const closeWithoutProjection = useCallback(() => {
    const lease = store.current
    if (lease) cancelInboxProjectionTicket(lease.ticket)
    publishProjection(store, null)
    const previousOpen = openRef.current
    openRef.current = false
    setOpen(false)
    return previousOpen
  }, [store])

  const onOpenChange = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
  }, [])

  const isProjected = useCallback((target: InboxRowTarget | null) => {
    if (!target || !projection) return false
    return projection.target.identity === target.identity
      && projection.target.fingerprint === target.fingerprint
  }, [projection])

  const isLatestProjection = useCallback((epoch: number) => (
    store.current?.epoch === epoch
  ), [store])

  useEffect(() => {
    const lease = store.current
    if (!lease || !lease.submitted || lease.phase !== "submitting") return
    if (destinationMatches(publishedHref, lease.destinationHref)) {
      commitLease(lease)
      return
    }
    if (navigationPending && destinationMatches(pendingHref, lease.destinationHref)) return
    rollbackProjection(lease.epoch)
  }, [commitLease, navigationPending, pendingHref, projection, publishedHref, rollbackProjection, store])

  return {
    open,
    onOpenChange,
    beginProjection,
    markProjectionSubmitted,
    rollbackProjection,
    closeWithoutProjection,
    isProjected,
    isLatestProjection,
  }
}
