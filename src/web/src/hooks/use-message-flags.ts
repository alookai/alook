"use client"

import { useCallback, useMemo } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { flagMessage, unflagMessage, listFlaggedMessageIds } from "@/lib/api"
import { isAbortError } from "@/lib/errors"
import { useFlagCount } from "@/contexts/flag-count-context"
import { assertApplicationOwner } from "@/lib/application-owner"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"
import type { ChatFlagsData } from "@/lib/workspace-chat-flags"
import { assertChatIntent, captureChatIntent } from "./workspace/use-chat-data"

type ChatView = Parameters<typeof captureChatIntent>[1]
const EMPTY_IDS: string[] = []
export function useMessageFlags(owner: WorkspaceOwner, view: ChatView, conversationId: string | null) {
  const key = useMemo(() => owner.key("chat", "flags", conversationId ?? "__none__"), [owner, conversationId])
  const readIntent = useMemo(() => captureWorkspaceOwner(owner), [owner])
  const query = useQuery({ queryKey: key, enabled: !!conversationId, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      assertWorkspaceOwner(readIntent, signal)
      const requestRevision = owner.queryClient.getQueryData<ChatFlagsData>(key)?.revision ?? 0
      const data = await listFlaggedMessageIds(owner.workspaceId, conversationId!, workspaceRequestOptions(readIntent, signal))
      assertWorkspaceOwner(readIntent, signal)
      return { ids: data.message_ids, requestRevision } satisfies ChatFlagsData
    },
  })
  const { begin, rollback, refresh } = useFlagCount()
  const mutation = useMutation({ meta: { observabilityAction: "message.flag.toggle" }, scope: { id: `${owner.application.userId}:${owner.workspaceId}:flags:${conversationId}` },
    mutationFn: async ({ messageId, intent }: { messageId: string; intent: ReturnType<typeof captureChatIntent> }) => {
      assertChatIntent(intent)
      await owner.queryClient.cancelQueries({ queryKey: key, exact: true })
      assertChatIntent(intent)
      const wasFlagged = (owner.queryClient.getQueryData<ChatFlagsData>(key)?.ids ?? EMPTY_IDS).includes(messageId)
      const publish = (flagged: boolean) => {
        let writeRevision = 0
        owner.queryClient.setQueryData<ChatFlagsData>(key, (previous) => {
          const ids = new Set(previous?.ids ?? EMPTY_IDS)
          if (flagged) ids.add(messageId); else ids.delete(messageId)
          const revision = (previous?.revision ?? 0) + 1
          writeRevision = revision
          return { ...previous, ids: [...ids], revision, writes: { ...previous?.writes, [messageId]: { flagged, revision } } }
        })
        return writeRevision
      }
      const optimisticRevision = publish(!wasFlagged)
      const flagsResource = owner.queryClient.getQueryCache().find({ queryKey: key, exact: true })
      const countTicket = begin(wasFlagged ? -1 : 1)
      try {
        const options = workspaceRequestOptions(captureWorkspaceOwner(owner), undefined, () => assertChatIntent(intent))
        if (wasFlagged) await unflagMessage(owner.workspaceId, messageId, options)
        else await flagMessage(owner.workspaceId, messageId, options)
        assertChatIntent(intent)
        refresh()
      } catch (error) {
        try { assertApplicationOwner(intent.workspace.application) } catch { return }
        const sameFlagsResource = !!flagsResource && owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === flagsResource
        if (sameFlagsResource && owner.queryClient.getQueryData<ChatFlagsData>(key)?.writes?.[messageId]?.revision === optimisticRevision) publish(wasFlagged)
        rollback(countTicket)
        await Promise.all([
          sameFlagsResource ? owner.queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" }) : Promise.resolve(),
          countTicket.query && owner.queryClient.getQueryCache().find({ queryKey: owner.key("flag-count"), exact: true }) === countTicket.query ? owner.queryClient.invalidateQueries({ queryKey: owner.key("flag-count"), exact: true, refetchType: "none" }) : Promise.resolve(),
        ])
        if (isAbortError(error)) return
      }
    },
  })
  const mutateFlag = mutation.mutateAsync
  const handleToggleFlag = useCallback(async (messageId: string) => {
    if (!conversationId) return
    const intent = captureChatIntent(owner, view)
    try { await mutateFlag({ messageId, intent }) } catch (error) { if (!isAbortError(error)) throw error }
  }, [owner, view, conversationId, mutateFlag])
  const flaggedIds = useMemo(() => new Set(query.data?.ids ?? EMPTY_IDS), [query.data])
  return { flaggedIds, handleToggleFlag }
}
