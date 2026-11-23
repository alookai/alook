"use client"

import { useEffect, useMemo } from "react"
import type { QueryClient } from "@tanstack/react-query"
import type { CommunityConversationEntryRead, CommunityReadStateResource } from "@alook/shared"
import {
  createConversationTimelineStore,
  selectTimelineNewDivider,
  type ConversationTimelineStore,
  type TimelineCanonicalPage,
} from "@/lib/community/conversation-timeline"
import {
  materializeMessageStream,
  reduceMessageOverlay,
  type CanonicalMessage,
  type MessageOverlayIds,
  type MessageScope,
} from "@/lib/community/message-stream"
import type { Msg } from "@/lib/community/models/message"
import { getCommunityRuntime } from "@/stores/community/runtime"

type UseConversationTimelineInput = Readonly<{
  client: QueryClient
  channelId: string | null
  scope: MessageScope
  viewerUserId?: string | null
  tag: string | null
  canRead: boolean
  revoked: boolean
  denied: boolean
  canonicalBase: CanonicalMessage[]
  presentationResources: ReadonlyMap<string, CanonicalMessage>
  overlay: MessageOverlayIds
  pages: readonly TimelineCanonicalPage[]
  readSnapshot: CommunityReadStateResource | null
  newBoundary?: CommunityConversationEntryRead["newBoundary"]
  targetCovered: boolean
  reconciling: boolean
  initialLoadError: Error | null
  targetLoadError: Error | null
}>

function messageMatchesTag(message: Msg, tag: string | null): boolean {
  return !tag || message.thread?.tags?.includes(tag) === true
}

export function useConversationTimeline(input: UseConversationTimelineInput) {
  const {
    client,
    channelId,
    scope,
    viewerUserId,
    tag,
    canRead,
    revoked,
    denied,
    canonicalBase,
    presentationResources,
    overlay,
    pages,
    readSnapshot,
    newBoundary,
    targetCovered,
    reconciling,
    initialLoadError,
    targetLoadError,
  } = input

  const timelineStore = useMemo<ConversationTimelineStore>(
    () => createConversationTimelineStore({
      channelId: channelId ?? "__none__",
      viewerUserId: viewerUserId ?? null,
      tag,
    }),
    // Recreate only when the channel changes; viewer/tag updates flow through actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId],
  )

  const reducedOverlay = useMemo(
    () => reduceMessageOverlay(overlay, { type: "baseChanged", messages: canonicalBase }, presentationResources),
    [overlay, canonicalBase, presentationResources],
  )
  const overlayNeedsSync = reducedOverlay.state !== overlay

  useEffect(() => {
    if (!channelId || !overlayNeedsSync) return
    getCommunityRuntime(client).messageStream.actions.dispatch(scope, {
      type: "baseChanged",
      messages: canonicalBase,
    })
  }, [canonicalBase, channelId, client, overlayNeedsSync, scope])

  useEffect(() => {
    timelineStore.dispatch({ type: "updateViewer", viewerUserId: viewerUserId ?? null })
  }, [timelineStore, viewerUserId])

  useEffect(() => {
    timelineStore.dispatch({ type: "setTag", tag })
  }, [timelineStore, tag])

  useEffect(() => {
    if (revoked || denied) {
      timelineStore.dispatch({ type: "revokeAccess", accessDenied: denied })
      return
    }
    if (pages.length > 0) {
      const payload = {
        pages,
        readSnapshot,
        accessQualified: canRead,
        targetCovered,
        reconcilingTarget: reconciling,
        ...(newBoundary ? { newBoundary } : {}),
      }
      timelineStore.dispatch(
        reconciling
          ? { type: "hydrateCache", payload }
          : { type: "reconcileNetwork", payload },
      )
    }
    if (initialLoadError) {
      timelineStore.dispatch({ type: "recordNetworkError", error: initialLoadError })
    } else if (targetLoadError) {
      timelineStore.dispatch({ type: "recordNetworkError", error: targetLoadError, targetOnly: true })
    }
  }, [
    canRead,
    denied,
    initialLoadError,
    newBoundary,
    pages,
    readSnapshot,
    reconciling,
    revoked,
    targetCovered,
    targetLoadError,
    timelineStore,
  ])

  const messages = useMemo<Msg[]>(() => {
    if (!canRead || revoked || denied) return []
    const materialized = materializeMessageStream(
      canonicalBase,
      reducedOverlay.state,
      presentationResources,
    )
    return tag ? materialized.filter((message) => messageMatchesTag(message, tag)) : materialized
  }, [canRead, canonicalBase, denied, presentationResources, reducedOverlay.state, revoked, tag])

  const newDividerBefore = useMemo(
    () =>
      newBoundary
        ? selectTimelineNewDivider(messages, {
            targetId: newBoundary.target?.id,
            targetSeq: newBoundary.target?.seq ?? null,
            afterSeq: newBoundary.afterSeq,
          })
        : undefined,
    [messages, newBoundary],
  )

  return {
    timelineStore,
    messages,
    newDividerBefore,
  }
}
