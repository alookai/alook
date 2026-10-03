"use client"

import { useMemo, useCallback } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { skipToken, useQuery, type QueryKey } from "@tanstack/react-query"
import type { Artifact } from "@alook/shared"
import type { WorkspaceOwner } from "@/contexts/workspace-context"
import { chatExtrasKey } from "@/lib/chat-cache"
import { captureChatIntent, assertChatIntent } from "./use-chat-data"

type ChatView = Parameters<typeof captureChatIntent>[1]
export function useChatArtifactSelection(owner: WorkspaceOwner, view: ChatView, issueId: string | null) {
  const selection = useMemo(() => createStore<{ key: QueryKey; id: string } | null>(null), [])
  const reference = useSelector(selection, (state) => state)
  const artifact = useQuery({ queryKey: reference?.key ?? owner.key("artifacts", "__none__"), queryFn: skipToken, enabled: false,
    select: (data: { artifacts?: Artifact[] }) => data.artifacts?.find((row) => row.id === reference?.id) ?? null,
  }).data ?? null
  const setArtifact = useCallback((row: Artifact | null) => {
    assertChatIntent(captureChatIntent(owner, view))
    if (!row) { selection.setState(() => null); return }
    const issueKey = owner.key("issues", "detail", issueId ?? "__none__")
    const issue = owner.queryClient.getQueryData<{ artifacts: Artifact[] }>(issueKey)
    const key = issue?.artifacts.some((candidate) => candidate.id === row.id) ? issueKey : chatExtrasKey(owner, row.conversation_id)
    selection.setState(() => ({ key, id: row.id }))
  }, [owner, view, issueId, selection])
  return [artifact, setArtifact] as const
}
