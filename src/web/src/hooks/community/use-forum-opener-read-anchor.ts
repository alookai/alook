"use client"

import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  registerReadSurface,
  releaseReadSurface,
  resumeReadCoordinator,
  submitReadIntent,
} from "./read-coordinator"

export function useForumOpenerReadAnchor({
  element,
  openerMessageId,
  parentChannelId,
  parentSeq,
  snapshotReady,
}: {
  element: HTMLElement | null
  openerMessageId: string | null
  parentChannelId: string | null
  parentSeq: number | null
  snapshotReady: boolean
}) {
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()

  useEffect(() => {
    if (
      !element
      || !openerMessageId
      || !parentChannelId
      || parentSeq === null
      || !snapshotReady
      || typeof IntersectionObserver === "undefined"
    ) return
    const lease = registerReadSurface(queryClient, currentUser.id, {
      kind: "forum-opener",
      openerMessageId,
      parentChannelId,
      parentSeq,
    })
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!active || document.visibilityState !== "visible") return
      for (const entry of entries) {
        if (entry.target !== element || !element.isConnected) return
        if (!entry.isIntersecting || entry.intersectionRatio < 0.2) continue
        submitReadIntent(lease, {
          kind: "forum-opener",
          openerMessageId,
          parentChannelId,
          parentSeq,
        })
      }
    }, { threshold: 0.2 })
    observer.observe(element)
    const sample = () => {
      if (document.visibilityState !== "visible") return
      observer.takeRecords()
      observer.unobserve(element)
      observer.observe(element)
      resumeReadCoordinator(queryClient)
    }
    document.addEventListener("visibilitychange", sample)
    window.addEventListener("pageshow", sample)
    return () => {
      active = false
      observer.disconnect()
      document.removeEventListener("visibilitychange", sample)
      window.removeEventListener("pageshow", sample)
      releaseReadSurface(lease)
    }
  }, [
    currentUser.id,
    element,
    openerMessageId,
    parentChannelId,
    parentSeq,
    queryClient,
    snapshotReady,
  ])
}
