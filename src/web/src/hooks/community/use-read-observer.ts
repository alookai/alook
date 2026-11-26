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

export const READ_VISIBILITY_THRESHOLD = 0.2
const MESSAGE_LIST_CONTENT_SELECTOR = "[data-message-list-content]"
const MESSAGE_ROWS_SELECTOR = "[data-message-rows]"

function escapeAttrValue(value: string): string {
  return value.replace(/["\\\n\r\f]/g, "\\$&")
}

function readPresentationReadable(scrollRootEl: HTMLElement) {
  const parentLayer = scrollRootEl.closest("[data-thread-parent]")
  if (parentLayer?.hasAttribute("inert") || parentLayer?.hasAttribute("data-read-observation-paused")) return false
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
    const node = scrollRootEl.querySelector<HTMLElement>(`[data-msg-id="${escapeAttrValue(correlated.id)}"]`)
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
    let bindings = new WeakMap<Element, { id: string; generation: number }>()
    let observer: IntersectionObserver
    let observerActive = false
    const retireObserver = () => {
      if (!observerActive) return
      observerGeneration += 1
      observerActive = false
      observer.disconnect()
      observer.takeRecords()
    }
    const bind = (node: Element) => {
      if (!observerActive) return
      const id = (node as HTMLElement).dataset.msgId
      if (!id) return
      const previous = bindings.get(node)
      if (previous) {
        if (previous.id !== id) sample()
        return
      }
      bindings.set(node, { id, generation: observerGeneration })
      observer.observe(node)
    }
    const unbind = (node: Element) => {
      if (!observerActive) return
      if (!bindings.has(node)) return
      bindings.delete(node)
      observer.unobserve(node)
    }
    const collectMsgNodes = (node: Node, out: Element[]) => {
      if ((node as { nodeType?: number }).nodeType !== 1) return
      const element = node as Element
      if (element.matches?.("[data-msg-id]")) out.push(element)
      element.querySelectorAll?.("[data-msg-id]").forEach((child) => out.push(child))
    }
    const createObserver = () => {
      const observerEpoch = observerGeneration
      const currentBindings = new WeakMap<Element, { id: string; generation: number }>()
      bindings = currentBindings
      observerActive = true
      return new IntersectionObserver((entries) => {
        if (observerEpoch !== observerGeneration) return
        if (!readPresentationReadable(scrollRootEl)) return
        if (!protocol.get().ready) return
        if (document.visibilityState !== "visible") {
          takeInboxReadReservationNegative(reservationLease)
          return
        }
        for (const entry of entries) {
          const binding = currentBindings.get(entry.target)
          if (!binding || binding.generation !== observerEpoch) continue
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
          if (generation !== null && correlated) {
            promoteInboxReadReservation(reservationLease, generation)
          }
        }
      }, {
        root: scrollRootEl,
        rootMargin: `0px 0px -${Number(scrollRootEl.dataset.composerOcclusion) || 0}px 0px`,
        threshold: READ_VISIBILITY_THRESHOLD,
      })
    }
    observer = createObserver()

    const sample = () => {
      if (!readPresentationReadable(scrollRootEl)) return
      retireObserver()
      if (document.visibilityState !== "visible") {
        takeInboxReadReservationNegative(reservationLease)
        return
      }
      observer = createObserver()
      scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]").forEach(bind)
      resumeReadCoordinator(queryClient)
    }
    scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]").forEach(bind)

    const observedContainers = new Set<Element>()
    let observedContentEl: HTMLElement | null = null
    let observedRowsEl: HTMLElement | null = null

    const mutations = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const nextPresentationReadable = readPresentationReadable(scrollRootEl)
          const presentationRevealed = !presentationReadable && nextPresentationReadable
          const presentationChanged = presentationReadable !== nextPresentationReadable
            || records.some((record) => record.type === "attributes"
              && (record.attributeName === "data-read-position-ready" && record.oldValue === "false"
                || record.attributeName === "data-composer-occlusion"))
          attachScopedContainers()
          if (presentationChanged) {
            retireObserver()
          }
          presentationReadable = nextPresentationReadable
          if (presentationRevealed || (presentationChanged && nextPresentationReadable)) {
            sample()
            if (document.visibilityState === "visible") classifyCandidateRef.current()
            return
          }
          if (records.some((record) => record.type === "attributes" && record.attributeName === "data-msg-id")) {
            sample()
            return
          }
          const removedElements: Element[] = []
          const addedElements: Element[] = []
          for (const record of records) {
            if (record.removedNodes) {
              for (const node of record.removedNodes) collectMsgNodes(node, removedElements)
            }
            if (record.addedNodes) {
              for (const node of record.addedNodes) collectMsgNodes(node, addedElements)
            }
          }
          if (removedElements.length > 0 && addedElements.length > 0) {
            const removedSet = new Set(removedElements)
            if (addedElements.some((element) => removedSet.has(element))) {
              sample()
              return
            }
          }
          for (const element of removedElements) unbind(element)
          for (const element of addedElements) bind(element)
        })

    const attachScopedContainers = () => {
      if (!mutations) return
      const contentEl = scrollRootEl.querySelector<HTMLElement>(MESSAGE_LIST_CONTENT_SELECTOR)
      if (contentEl && contentEl !== observedContentEl && !observedContainers.has(contentEl)) {
        observedContentEl = contentEl
        observedContainers.add(contentEl)
        mutations.observe(contentEl, {
          attributes: true,
          attributeFilter: ["aria-hidden", "inert", "data-read-position-ready"],
          attributeOldValue: true,
          childList: true,
          subtree: false,
        })
      }
      const rowsEl = scrollRootEl.querySelector<HTMLElement>(MESSAGE_ROWS_SELECTOR)
      if (rowsEl && rowsEl !== observedRowsEl && !observedContainers.has(rowsEl)) {
        observedRowsEl = rowsEl
        observedContainers.add(rowsEl)
        mutations.observe(rowsEl, {
          childList: true,
          subtree: false,
        })
      }
    }

    mutations?.observe(scrollRootEl, {
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "data-read-position-ready", "data-composer-occlusion"],
      attributeOldValue: true,
      childList: true,
      subtree: false,
    })
    attachScopedContainers()
    const parentLayer = scrollRootEl.closest("[data-thread-parent]")
    if (parentLayer) mutations?.observe(parentLayer, {
      attributes: true, attributeFilter: ["inert", "data-read-observation-paused"], attributeOldValue: true,
    })
    document.addEventListener("visibilitychange", sample)
    window.addEventListener("pageshow", sample)
    return () => {
      retireObserver()
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
