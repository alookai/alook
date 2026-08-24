"use client"

import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useCurrentUser } from "@/contexts/community/current-user"
import type { Msg } from "@/lib/community/models/message"
import {
  registerReadSurface,
  releaseReadSurface,
  resumeReadCoordinator,
  submitReadIntent,
} from "./read-coordinator"

const READ_VISIBILITY_THRESHOLD = 0.2

export function useTimelineReadObserver({
  channelId,
  messages,
  scrollRootEl,
  snapshotReady,
  confirmedSeq,
}: {
  channelId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
  snapshotReady: boolean
  confirmedSeq: number
}) {
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const messagesRef = useRef(messages)
  const readyRef = useRef(snapshotReady)

  useEffect(() => {
    messagesRef.current = messages
    readyRef.current = snapshotReady
  }, [messages, snapshotReady])

  useEffect(() => {
    if (!channelId || !scrollRootEl || !snapshotReady) return
    if (typeof IntersectionObserver === "undefined") return
    const lease = registerReadSurface(
      queryClient,
      currentUser.id,
      { kind: "timeline", channelId },
      confirmedSeq,
    )
    let observerGeneration = 0
    const bindings = new WeakMap<Element, { id: string; generation: number }>()
    const bind = (node: Element) => {
      const id = (node as HTMLElement).dataset.msgId
      if (!id) return
      bindings.set(node, { id, generation: observerGeneration })
      observer.observe(node)
    }
    const observer = new IntersectionObserver((entries) => {
      if (!readyRef.current || document.visibilityState !== "visible") return
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < READ_VISIBILITY_THRESHOLD) continue
        const binding = bindings.get(entry.target)
        if (!binding || binding.generation !== observerGeneration) continue
        if (!scrollRootEl.contains(entry.target)) continue
        if ((entry.target as HTMLElement).dataset.msgId !== binding.id) continue
        const message = messagesRef.current.find((row) => row.id === binding.id)
        if (!message?.seq || message.authorId === currentUser.id) continue
        submitReadIntent(lease, {
          kind: "timeline",
          channelId,
          messageId: message.id,
          seq: message.seq,
        })
      }
    }, { root: scrollRootEl, threshold: READ_VISIBILITY_THRESHOLD })

    const sample = () => {
      if (document.visibilityState !== "visible") return
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
    const onVisibility = () => sample()
    const onPageShow = () => sample()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      observerGeneration += 1
      observer.disconnect()
      mutations?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      releaseReadSurface(lease)
    }
  }, [
    channelId,
    confirmedSeq,
    currentUser.id,
    queryClient,
    scrollRootEl,
    snapshotReady,
  ])

  useEffect(() => {
    if (!channelId || !snapshotReady || document.visibilityState !== "visible") return
    resumeReadCoordinator(queryClient)
  }, [channelId, messages, queryClient, snapshotReady])
}
