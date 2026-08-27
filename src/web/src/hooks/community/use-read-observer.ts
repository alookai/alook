"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
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

const READ_VISIBILITY_THRESHOLD = 0.2

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
  const messagesRef = useRef(messages)
  const readyRef = useRef(snapshotStatus === "ready" && feedStatus === "ready")
  const candidateRef = useRef<InboxReadCandidate | null>(null)
  const readLeaseRef = useRef<ReturnType<typeof registerReadSurface> | null>(null)
  const reservationLeaseRef = useRef<InboxReadReservationLease | null>(null)
  const catchUpStartedRef = useRef(new Set<string>())
  const catchUpSettledRef = useRef(new Set<string>())
  const [candidate, setCandidate] = useState<InboxReadCandidate | null>(null)
  const [, setCatchUpVersion] = useState(0)

  useLayoutEffect(() => {
    messagesRef.current = messages
    readyRef.current = snapshotStatus === "ready" && feedStatus === "ready"
    candidateRef.current = candidate
  }, [candidate, feedStatus, messages, snapshotStatus])

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
  }, [channelId, currentUser.id, queryClient])

  useEffect(() => {
    const lease = readLeaseRef.current
    if (!lease || snapshotStatus !== "ready") return
    confirmReadSurface(lease, confirmedSeq)
  }, [confirmedSeq, snapshotStatus])

  useEffect(() => {
    if (!candidate || !channelId) return
    const reservationLease = reservationLeaseRef.current
    if (!reservationLease) return
    if (snapshotStatus === "pending" || feedStatus === "pending" || !scrollRootEl) return
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
        && !catchUpStartedRef.current.has(candidate.fingerprint)
      ) {
        catchUpStartedRef.current.add(candidate.fingerprint)
        void catchUp().finally(() => {
          catchUpSettledRef.current.add(candidate.fingerprint)
          setCatchUpVersion((value) => value + 1)
        })
        return
      }
      if (
        !loadedTail
        || loadedTail >= candidate.lastMessageAt
        || catchUpSettledRef.current.has(candidate.fingerprint)
      ) {
        takeInboxReadReservationNegative(reservationLease)
      }
      return
    }
    const node = [...scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]")]
      .find((element) => element.dataset.msgId === correlated.id)
    if (!node) takeInboxReadReservationNegative(reservationLease)
  }, [
    candidate,
    catchUp,
    channelId,
    feedStatus,
    messages,
    scrollRootEl,
    snapshotStatus,
    tailAttached,
  ])

  useEffect(() => {
    if (!channelId || !scrollRootEl) return
    if (typeof IntersectionObserver === "undefined") return
    const readLease = readLeaseRef.current
    const reservationLease = reservationLeaseRef.current
    if (!readLease || !reservationLease) return
    let observerGeneration = 0
    const bindings = new WeakMap<Element, { id: string; generation: number }>()
    const bind = (node: Element) => {
      const id = (node as HTMLElement).dataset.msgId
      if (!id) return
      bindings.set(node, { id, generation: observerGeneration })
      observer.observe(node)
    }
    const observer = new IntersectionObserver((entries) => {
      if (!readyRef.current) return
      if (document.visibilityState !== "visible") {
        takeInboxReadReservationNegative(reservationLease)
        return
      }
      for (const entry of entries) {
        const binding = bindings.get(entry.target)
        if (!binding || binding.generation !== observerGeneration) continue
        if (!scrollRootEl.contains(entry.target)) continue
        if ((entry.target as HTMLElement).dataset.msgId !== binding.id) continue
        const message = messagesRef.current.find((row) => row.id === binding.id)
        if (!message?.seq || message.authorId === currentUser.id) continue
        const activeCandidate = candidateRef.current
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
        if (generation !== null && correlated) {
          promoteInboxReadReservation(reservationLease, generation)
        }
      }
    }, { root: scrollRootEl, threshold: READ_VISIBILITY_THRESHOLD })

    const sample = () => {
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
          for (const record of records) {
            for (const node of record.addedNodes) {
              if ((node as { nodeType?: number }).nodeType !== 1) continue
              const element = node as Element
              if (element.matches?.("[data-msg-id]")) bind(element)
              element.querySelectorAll?.("[data-msg-id]").forEach(bind)
            }
          }
        })
    mutations?.observe(scrollRootEl, { childList: true, subtree: true })
    document.addEventListener("visibilitychange", sample)
    window.addEventListener("pageshow", sample)
    return () => {
      observerGeneration += 1
      observer.disconnect()
      mutations?.disconnect()
      document.removeEventListener("visibilitychange", sample)
      window.removeEventListener("pageshow", sample)
    }
  }, [channelId, currentUser.id, feedStatus, queryClient, scrollRootEl, snapshotStatus])

  useEffect(() => {
    if (!channelId || snapshotStatus !== "ready" || document.visibilityState !== "visible") return
    resumeReadCoordinator(queryClient)
  }, [channelId, messages, queryClient, snapshotStatus])
}
