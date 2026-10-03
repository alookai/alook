"use client"

import { useEffect, useMemo, useCallback } from "react"
import { useSelector } from "@tanstack/react-store"
import { useQuery, skipToken } from "@tanstack/react-query"
import type { Conversation, WsMessage } from "@alook/shared"
import { getThreadSummaries, getAgentSkills } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"
import { chatMessagesKey, sortedChatMessages, type ChatMessagesData } from "@/lib/chat-cache"
import { captureChatIntent, assertChatIntent } from "./use-chat-data"

type ChatView = Parameters<typeof captureChatIntent>[1]
export type ChatRootReference = { conversationId: string; id: string }
export function useChatThreadResources(owner: WorkspaceOwner, view: ChatView, conversation: Conversation | null, agentId: string, subscribeWs: (callback: (message: WsMessage) => void) => () => void) {
  const generation = useSelector(view, (state) => state.generation)
  const factOrigin = useMemo(() => captureWorkspaceOwner(owner), [owner])
  const intent = useMemo(() => ({ workspace: captureWorkspaceOwner(owner), view, generation }), [owner, view, generation])
  const root = useQuery<ChatRootReference | null>({ queryKey: owner.key("chat", "thread-root", conversation?.id ?? "__none__"), queryFn: skipToken, enabled: false }).data
  const rootMessages = useQuery<ChatMessagesData>({ queryKey: chatMessagesKey(owner, root?.conversationId ?? "__none__"), queryFn: skipToken, enabled: false }).data
  const threadRootMessage = useMemo(() => root ? sortedChatMessages(rootMessages).find((row) => row.id === root.id) ?? null : null, [root, rootMessages])
  const key = useMemo(() => owner.key("chat", "thread-summaries", conversation?.id ?? "__none__"), [owner, conversation?.id])
  const summaries = useQuery({ queryKey: key, meta: { chatView: view, generation }, enabled: !!conversation?.id && !conversation.parent_message_id, subscribed: !!conversation?.id && !conversation.parent_message_id,
    queryFn: async ({ signal }) => {
      assertWorkspaceOwner(factOrigin, signal)
      const data = await getThreadSummaries(conversation!.id, owner.workspaceId, workspaceRequestOptions(factOrigin, signal))
      assertWorkspaceOwner(factOrigin, signal)
      return data
    },
  }).data
  const threadSummaries = useMemo(() => new Map((summaries?.thread_summaries ?? []).map((row) => [row.parent_message_id, row])), [summaries])
  const fetchThreadSummaries = useCallback(() => owner.queryClient.invalidateQueries({ queryKey: key, exact: true }), [owner, key])
  useEffect(() => {
    return subscribeWs((message) => {
      try { assertChatIntent(intent) } catch { return }
      if ((message.type === "thread.created" || message.type === "thread.reply") && message.conversationId === conversation?.id) void fetchThreadSummaries()
    })
  }, [owner, view, subscribeWs, conversation?.id, fetchThreadSummaries, intent])
  const agentSkills = useQuery({ queryKey: owner.key("agent-skills", agentId), meta: { chatView: view, generation },
    queryFn: async ({ signal }) => {
      assertWorkspaceOwner(factOrigin, signal)
      const data = await getAgentSkills(agentId, owner.workspaceId, workspaceRequestOptions(factOrigin, signal))
      assertWorkspaceOwner(factOrigin, signal)
      return data.skills
    },
  }).data ?? EMPTY_SKILLS
  return { threadRootMessage, threadSummaries, fetchThreadSummaries, agentSkills, readThreadSummary: (messageId: string) => owner.queryClient.getQueryData<Awaited<ReturnType<typeof getThreadSummaries>>>(key)?.thread_summaries.find((row) => row.parent_message_id === messageId), summariesKey: key }
}
const EMPTY_SKILLS: Awaited<ReturnType<typeof getAgentSkills>>["skills"] = []
