"use client"

import { createStore, useSelector } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useRef, useMemo } from "react"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityViewSource } from "./use-community-view-source"
import { useQueryClient } from "@tanstack/react-query"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  confirmReadSurface,
  registerReadSurface,
  releaseReadSurface,
  resumeReadCoordinator,
  submitReadIntentGeneration,
} from "./read-coordinator"
import {
  promoteInboxReadReservation,
  registerInboxReadReservationSurface,
  releaseInboxReadReservationSurface,
  takeInboxReadReservationNegative,
  type InboxReadCandidate,
  type InboxReadReservationLease,
} from "./inbox-read-reservation"
import { getAccountUnreadProjection } from "./account-unread-projection"

const READ_VISIBILITY_THRESHOLD = 0.2
const MESSAGE_LIST_CONTENT_SELECTOR = "[data-message-list-content]"

function readPresentationReadable(scrollRootEl: HTMLElement) {
  const content = scrollRootEl.querySelector<HTMLElement>(MESSAGE_LIST_CONTENT_SELECTOR)
  if (!content) return true
  return content.getAttribute("aria-hidden") === "false"
    && !content.hasAttribute("inert")
    && content.getAttribute("data-read-position-ready") !== "false"
}

export type ReadCandidate = {
  id: string
  seq?: number
  authorId?: string
  createdAt?: string
}

type Lifecycle = "pending" | "ready" | "error"

export function useTimelineReadObserver({
  channelId,
  messages,
  scrollRootEl,
  snapshotStatus,
  feedStatus,
  tailAttached,
  confirmedSeq,
  catchUp,
}: {
  channelId: string | null | undefined
  messages: ReadCandidate[]
  scrollRootEl: HTMLElement | null
  snapshotStatus: Lifecycle
  feedStatus: Lifecycle
  tailAttached: boolean
  confirmedSeq: number
  catchUp: () => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const source = useCommunityViewSource(`read-observer:${channelId}`, !!channelId)
  const protocol = useMemo(() => ({ scope: [queryClient, channelId, currentUser.id], store: createStore({ visibleIds: new Set<string>() as ReadonlySet<string>, ready: false, candidate: null as InboxReadCandidate | null, started: new Set<string>() as ReadonlySet<string>, settled: new Set<string>() as ReadonlySet<string> }) }), [queryClient, channelId, currentUser.id]).store
  const readLeaseRef = useRef<ReturnType<typeof registerReadSurface> | null>(null)
  const reservationLeaseRef = useRef<InboxReadReservationLease | null>(null)
  const candidate = useSelector(protocol, (state) => state.candidate)
  const settled = useSelector(protocol, (state) => state.settled)
  const setCandidate = useCallback((candidate: InboxReadCandidate | null) => protocol.setState((state) => ({ ...state, candidate })), [protocol])
  const classifyCandidateRef = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, visibleIds: new Set(messages.map((message) => message.id)), ready: snapshotStatus === "ready" && feedStatus === "ready" }))
  }, [feedStatus, messages, snapshotStatus, protocol])

  useLayoutEffect(() => {
    setCandidate(null)
    if (!channelId) return
    const reservationLease = registerInboxReadReservationSurface(
      queryClient,
      channelId,
      setCandidate,
    )
    const readLease = registerReadSurface(
      queryClient,
      currentUser.id,
      { kind: "timeline", channelId },
    )
    reservationLeaseRef.current = reservationLease
    readLeaseRef.current = readLease
    return () => {
      reservationLeaseRef.current = null
      readLeaseRef.current = null
      releaseInboxReadReservationSurface(reservationLease)
      releaseReadSurface(readLease)
    }
  }, [channelId, currentUser.id, queryClient, setCandidate])

  useEffect(() => {
    const lease = readLeaseRef.current
    if (!lease || snapshotStatus !== "ready") return
    confirmReadSurface(lease, confirmedSeq)
  }, [confirmedSeq, snapshotStatus])

  const classifyCandidate = useCallback(() => {
    if (!candidate || !channelId) return
    const reservationLease = reservationLeaseRef.current
    if (!reservationLease) return
    if (snapshotStatus === "pending" || feedStatus === "pending" || !scrollRootEl) return
    if (!readPresentationReadable(scrollRootEl)) return
    if (
      snapshotStatus === "error"
      || feedStatus === "error"
      || !tailAttached
      || document.visibilityState !== "visible"
    ) {
      takeInboxReadReservationNegative(reservationLease)
      return
    }
    const correlated = messages
      .filter((message) => message.createdAt === candidate.lastMessageAt)
      .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0))[0]
    if (!correlated) {
      const loadedTail = messages.reduce<string | undefined>((latest, message) => (
        message.createdAt && (!latest || message.createdAt > latest)
          ? message.createdAt
          : latest
      ), undefined)
      if (
        loadedTail
        && loadedTail < candidate.lastMessageAt
        && !protocol.get().started.has(candidate.fingerprint)
      ) {
        const original = source.capture()
        original()
        protocol.setState((state) => ({ ...state, started: new Set(state.started).add(candidate.fingerprint) }))
        void catchUp().catch(() => undefined).finally(() => {
          try { original() } catch { return }
          protocol.setState((state) => ({ ...state, settled: new Set(state.settled).add(candidate.fingerprint) }))
        })
        return
      }
      if (
        !loadedTail
        || loadedTail >= candidate.lastMessageAt
        || protocol.get().settled.has(candidate.fingerprint)
      ) {
        takeInboxReadReservationNegative(reservationLease)
      }
      return
    }
    const node = [...scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]")]
      .find((element) => element.dataset.msgId === correlated.id)
    if (!node) takeInboxReadReservationNegative(reservationLease)
  }, [candidate, catchUp, channelId, feedStatus, messages, protocol, scrollRootEl, snapshotStatus, source, tailAttached])

  useLayoutEffect(() => {
    classifyCandidateRef.current = classifyCandidate
  }, [classifyCandidate])

  useEffect(() => {
    classifyCandidate()
  }, [settled, classifyCandidate])

  useEffect(() => {
    if (!channelId || !scrollRootEl) return
    if (typeof IntersectionObserver === "undefined") return
    const readLease = readLeaseRef.current
    const reservationLease = reservationLeaseRef.current
    if (!readLease || !reservationLease) return
    let observerGeneration = 0
    let presentationReadable = readPresentationReadable(scrollRootEl)
    const bindings = new WeakMap<Element, { id: string; generation: number; observedAt: number }>()
    const bind = (node: Element) => {
      const id = (node as HTMLElement).dataset.msgId
      if (!id) return
      bindings.set(node, { id, generation: observerGeneration, observedAt: performance.now() })
      observer.observe(node)
    }
    const observer = new IntersectionObserver((entries) => {
      if (!readPresentationReadable(scrollRootEl)) return
      if (!protocol.get().ready) return
      if (document.visibilityState !== "visible") {
        takeInboxReadReservationNegative(reservationLease)
        return
      }
      for (const entry of entries) {
        const binding = bindings.get(entry.target)
        if (!binding || binding.generation !== observerGeneration || entry.time < binding.observedAt) continue
        if (!scrollRootEl.contains(entry.target)) continue
        if ((entry.target as HTMLElement).dataset.msgId !== binding.id) continue
        const message = protocol.get().visibleIds.has(binding.id) ? getCommunityDbRegistry(queryClient)?.collections.messages.get(binding.id) : undefined
        if (!message?.seq || message.authorId === currentUser.id) continue
        const activeCandidate = protocol.get().candidate
        const correlated = activeCandidate?.lastMessageAt === message.createdAt
        if (!entry.isIntersecting || entry.intersectionRatio < READ_VISIBILITY_THRESHOLD) {
          if (correlated) takeInboxReadReservationNegative(reservationLease)
          continue
        }
        const generation = submitReadIntentGeneration(readLease, {
          kind: "timeline",
          channelId,
          messageId: message.id,
          seq: message.seq,
        })
        if (generation !== null) {
          getAccountUnreadProjection(queryClient, currentUser.id)
            .recordOptimisticRead(channelId, message.seq, generation)
        }
        if (generation !== null && correlated) {
          promoteInboxReadReservation(reservationLease, generation)
        }
      }
    }, { root: scrollRootEl, threshold: READ_VISIBILITY_THRESHOLD })

    const sample = () => {
      if (!readPresentationReadable(scrollRootEl)) return
      if (document.visibilityState !== "visible") {
        takeInboxReadReservationNegative(reservationLease)
        return
      }
      observerGeneration += 1
      scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]").forEach((node) => {
        observer.unobserve(node)
        bind(node)
      })
      resumeReadCoordinator(queryClient)
    }
    scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]").forEach(bind)

    const mutations = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const nextPresentationReadable = readPresentationReadable(scrollRootEl)
          const presentationRevealed = !presentationReadable && nextPresentationReadable
          const presentationChanged = presentationReadable !== nextPresentationReadable
            || records.some((record) => record.type === "attributes"
              && record.attributeName === "data-read-position-ready" && record.oldValue === "false")
          if (presentationChanged) {
            observerGeneration += 1
            scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]").forEach((node) => observer.unobserve(node))
            observer.takeRecords()
          }
          presentationReadable = nextPresentationReadable
          if (presentationRevealed || (presentationChanged && nextPresentationReadable)) {
            sample()
            if (document.visibilityState === "visible") classifyCandidateRef.current()
            return
          }
          for (const record of records) {
            for (const node of record.addedNodes) {
              if ((node as { nodeType?: number }).nodeType !== 1) continue
              const element = node as Element
              if (element.matches?.("[data-msg-id]")) bind(element)
              element.querySelectorAll?.("[data-msg-id]").forEach(bind)
            }
          }
        })
    mutations?.observe(scrollRootEl, {
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "data-read-position-ready"],
      attributeOldValue: true,
      childList: true,
      subtree: true,
    })
    document.addEventListener("visibilitychange", sample)
    window.addEventListener("pageshow", sample)
    return () => {
      observerGeneration += 1
      observer.disconnect()
      mutations?.disconnect()
      document.removeEventListener("visibilitychange", sample)
      window.removeEventListener("pageshow", sample)
    }
  }, [channelId, currentUser.id, feedStatus, protocol, queryClient, scrollRootEl, snapshotStatus])

  useEffect(() => {
    if (
      !channelId
      || !scrollRootEl
      || snapshotStatus !== "ready"
      || document.visibilityState !== "visible"
      || !readPresentationReadable(scrollRootEl)
    ) return
    resumeReadCoordinator(queryClient)
  }, [channelId, messages, queryClient, scrollRootEl, snapshotStatus])
}
