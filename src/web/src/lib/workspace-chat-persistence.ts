import { cachedMessageSchema, cachedArtifactSchema, cachedConversationSchema } from "./workspace-chat-wire"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import type { ChatExtras, ChatMessagesData } from "@/lib/chat-cache"

export const MAX_WORKSPACE_CACHED_CONVERSATIONS = 50
export const MAX_WORKSPACE_CACHED_MESSAGES = 200
export function shouldPersistApplicationQuery(key: readonly unknown[]) {
  return key[0] === "application" && typeof key[1] === "string" && key[2] === "workspace" && typeof key[3] === "string" && key[4] === "chat" && (
    key.length === 7 && (key[5] === "messages" || key[5] === "extras") && typeof key[6] === "string" && key[6] !== "__none__"
    || key.length === 8 && key[5] === "latest-created" && typeof key[6] === "string" && typeof key[7] === "string"
  )
}
export function scrubApplicationClient(client: PersistedClient, userId: string | null): PersistedClient {
  const candidates = client.clientState.queries.filter((query) => userId && query.queryKey[1] === userId && shouldPersistApplicationQuery(query.queryKey))
  const retained = new Set<string>()
  const counts = new Map<string, number>()
  for (const query of candidates.slice().sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)) {
    if (query.queryKey[5] === "latest-created") continue
    const workspace = String(query.queryKey[3])
    const id = `${workspace}:${query.queryKey[6]}`
    if (retained.has(id)) continue
    const count = counts.get(workspace) ?? 0
    if (count >= MAX_WORKSPACE_CACHED_CONVERSATIONS) continue
    retained.add(id)
    counts.set(workspace, count + 1)
  }
  const queries: typeof client.clientState.queries = []
  for (const query of candidates) {
    const key = query.queryKey
    const id = `${key[3]}:${key[6]}`
    if (key[5] === "messages" && retained.has(id)) {
      const data = query.state.data as ChatMessagesData | undefined
      if (!data || !Array.isArray(data.pages) || !Number.isInteger(data.serverMessageCount) || data.serverMessageCount < 0) continue
      let corrupt = false
      const byId = new Map<string, ChatMessagesData["pages"][number]["messages"][number]>()
      for (const page of data.pages) {
        if (!page || !Array.isArray(page.messages) || typeof page.hasMore !== "boolean") { corrupt = true; continue }
        for (const row of page.messages) {
          const parsed = cachedMessageSchema.safeParse(row)
          if (!parsed.success || parsed.data.conversation_id !== key[6] || parsed.data.id.startsWith("temp-")) { corrupt = true; continue }
          byId.set(parsed.data.id, parsed.data)
        }
      }
      if (corrupt) continue
      const all = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      const messages = all.slice(-MAX_WORKSPACE_CACHED_MESSAGES)
      const bounded: ChatMessagesData = { pages: [{ messages, hasMore: all.length > messages.length || data.pages.at(-1)?.hasMore === true }], pageParams: [null], serverMessageCount: data.serverMessageCount }
      queries.push({ ...query, state: { ...query.state, data: bounded } })
    } else if (key[5] === "extras" && retained.has(id)) {
      const data = query.state.data as ChatExtras | undefined
      const conversation = cachedConversationSchema.safeParse(data?.conversation)
      if (!data || !conversation.success || conversation.data.id !== key[6] || !Array.isArray(data.artifacts)) continue
      const artifacts = data.artifacts.flatMap((row) => {
        const parsed = cachedArtifactSchema.safeParse(row)
        return parsed.success && parsed.data.conversation_id === key[6] ? [parsed.data] : []
      })
      queries.push({ ...query, state: { ...query.state, data: { conversation: conversation.data, artifacts, hasMoreArtifacts: artifacts.length < data.artifacts.length || data.hasMoreArtifacts === true } satisfies ChatExtras } })
    } else if (key[5] === "latest-created") {
      const data = query.state.data as { conversation_id?: string; serverMessageCount?: number; newestMessageId?: string | null } | undefined
      if (!data || typeof data.conversation_id !== "string" || !retained.has(`${key[3]}:${data.conversation_id}`) || typeof data.serverMessageCount !== "number" || !Number.isInteger(data.serverMessageCount) || data.serverMessageCount < 0 || !(typeof data.newestMessageId === "string" || data.newestMessageId === null)) continue
      queries.push(query)
    }
  }
  return { ...client, clientState: { ...client.clientState, mutations: [], queries } }
}
