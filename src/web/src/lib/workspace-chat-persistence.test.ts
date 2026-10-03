import "fake-indexeddb/auto"
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query"
import { persistQueryClientSave } from "@tanstack/react-query-persist-client"
import { describe, expect, it } from "vitest"
import { createIdbPersister, clearPersistedCache, clearAllPersistedCaches, PERSIST_BUSTER } from "./query-persister"
import { createApplicationOwner } from "./application-owner"
import { createWorkspaceOwner } from "@/contexts/workspace-context"
import { chatMessagesKey, chatExtrasKey, chatLatestKey, mergeCachedMessages, setConvExtras, setLastOpenConversation, getCachedMessages, getConvExtras } from "./chat-cache"
import { MAX_WORKSPACE_CACHED_CONVERSATIONS, MAX_WORKSPACE_CACHED_MESSAGES, shouldPersistApplicationQuery, scrubApplicationClient } from "./workspace-chat-persistence"
import { communityKeys } from "./query-keys"

function owner(user: string, workspace = "workspace") { return createWorkspaceOwner(createApplicationOwner(user), workspace, workspace) }
function message(id: string, conversation = "conv") { return { id, conversation_id: conversation, role: "user" as const, content: id, task_id: null, attachment_ids: null, created_at: new Date(Date.UTC(2026, 9, 1, 0, Number(id))).toISOString() } }
async function seed(workspace: ReturnType<typeof owner>, conversation = "conv") {
  await mergeCachedMessages(conversation, [message("1", conversation)], false, workspace, 1)
  await setConvExtras(conversation, { artifacts: [], conversation_type: "agent_chat", conversation_title: "Title", conversation_channel: "general", conversation_created_at: "2026-10-01T00:00:00Z", hasMoreArtifacts: false }, workspace)
  await setLastOpenConversation("agent", "general", { conversation_id: conversation, newestMessageId: "1", serverMessageCount: 1 }, workspace)
}
async function save(queryClient: QueryClient, persister: ReturnType<typeof createIdbPersister>, application = false) {
  await persistQueryClientSave({ queryClient, persister, buster: PERSIST_BUSTER, dehydrateOptions: { shouldDehydrateQuery: (q) => !application || shouldPersistApplicationQuery(q.queryKey) } })
}

describe("independent native payloads and shared original account eligibility", () => {
  it("two real clients save and restore their own warm facts without replacing the other payload", async () => {
    const user = "two-domains"
    await clearPersistedCache(user)
    const workspace = owner(user)
    await seed(workspace)
    const community = new QueryClient()
    community.setQueryData(communityKeys.communityDbCollection(user, "servers"), [{ id: "server", name: "Server", icon: null, position: 0, discriminator: "1234", description: "", official: false, isOwner: true, unread: false, mentions: 0, ownerId: user }])
    const app = createIdbPersister(user, "application")
    const social = createIdbPersister(user)
    await save(workspace.queryClient, app, true)
    await save(community, social)
    const restoredApp = owner(user)
    const appPayload = await createIdbPersister(user, "application").restoreClient()
    expect(appPayload?.clientState.queries).toHaveLength(3)
    hydrate(restoredApp.queryClient, appPayload!.clientState)
    const restoredCommunity = new QueryClient()
    const socialPayload = await createIdbPersister(user).restoreClient()
    hydrate(restoredCommunity, socialPayload!.clientState)
    expect(await getCachedMessages("conv", restoredApp)).toHaveLength(1)
    expect(await getConvExtras("conv", restoredApp)).toMatchObject({ conversation_title: "Title" })
    expect(restoredCommunity.getQueryData(communityKeys.communityDbCollection(user, "servers"))).toMatchObject([{ id: "server" }])
    expect(restoredApp.queryClient.getQueryData(communityKeys.communityDbCollection(user, "servers"))).toBeUndefined()
    await clearPersistedCache(user)
    await save(workspace.queryClient, app, true)
    await save(community, social)
    expect(await createIdbPersister(user, "application").restoreClient()).toBeUndefined()
    expect(await createIdbPersister(user).restoreClient()).toBeUndefined()
    for (const client of [workspace.queryClient, community, restoredApp.queryClient, restoredCommunity]) client.clear()
  })

  it.each(["account", "device"])("%s clear fences both original writers before their first payload", async (scope) => {
    const user = `unwritten-${scope}`
    const a = createIdbPersister(user, "application"), c = createIdbPersister(user)
    await Promise.all([a.restoreClient(), c.restoreClient()])
    if (scope === "account") await clearPersistedCache(user)
    else await clearAllPersistedCaches()
    const blank = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(new QueryClient()) }
    await Promise.all([a.persistClient(blank), c.persistClient(blank)])
    expect(await createIdbPersister(user, "application").restoreClient()).toBeUndefined()
    expect(await createIdbPersister(user).restoreClient()).toBeUndefined()
  })

  it("bounds workspace restore and removes dangling cards/pointers while keeping the live cache intact", async () => {
    const workspace = owner("bounded-workspace")
    for (let i = 0; i < MAX_WORKSPACE_CACHED_CONVERSATIONS + 2; i++) {
      const id = `conv-${i}`
      await seed(workspace, id)
      for (const key of [chatMessagesKey(workspace, id), chatExtrasKey(workspace, id)]) {
        const data = workspace.queryClient.getQueryData(key)
        workspace.queryClient.setQueryData(key, data, { updatedAt: i + 1 })
      }
    }
    await mergeCachedMessages("conv-51", Array.from({ length: MAX_WORKSPACE_CACHED_MESSAGES + 5 }, (_, i) => message(String(i), "conv-51")), false, workspace)
    await setLastOpenConversation("agent", "old-channel", { conversation_id: "conv-0", newestMessageId: "1", serverMessageCount: 1 }, workspace)
    const persister = createIdbPersister(workspace.application.userId, "application")
    await save(workspace.queryClient, persister, true)
    const fresh = owner(workspace.application.userId)
    hydrate(fresh.queryClient, (await persister.restoreClient())!.clientState)
    expect(await getCachedMessages("conv-0", fresh)).toBeNull()
    expect(await getConvExtras("conv-0", fresh)).toBeNull()
    expect(fresh.queryClient.getQueryData(chatLatestKey(fresh, "agent", "old-channel"))).toBeUndefined()
    expect(await getCachedMessages("conv-51", fresh)).toHaveLength(MAX_WORKSPACE_CACHED_MESSAGES)
    expect((fresh.queryClient.getQueryData(chatMessagesKey(fresh, "conv-51")) as { pages: Array<{ hasMore: boolean }> }).pages[0].hasMore).toBe(true)
    expect(await getCachedMessages("conv-51", workspace)).toHaveLength(MAX_WORKSPACE_CACHED_MESSAGES + 5)
    expect(fresh.queryClient.getQueryData(chatLatestKey(fresh, "agent", "general"))).toMatchObject({ conversation_id: "conv-51" })
    workspace.queryClient.clear(); fresh.queryClient.clear()
  })

  it.each(["attachments", "page", "count"])("rejects the entire incomplete message snapshot: %s", async (damage) => {
    const workspace = owner(`damaged-${damage}`)
    await seed(workspace)
    const key = chatMessagesKey(workspace, "conv")
    const data = workspace.queryClient.getQueryData(key) as { pages: Array<{ messages: unknown[]; hasMore: boolean }>; serverMessageCount: number }
    if (damage === "attachments") data.pages[0].messages.push({ ...message("2"), attachment_ids: [123] })
    if (damage === "page") data.pages.push({ messages: null, hasMore: false } as never)
    if (damage === "count") data.serverMessageCount = -1
    const scrubbed = scrubApplicationClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(workspace.queryClient) }, workspace.application.userId)
    expect(scrubbed.clientState.queries.some((query) => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
    workspace.queryClient.clear()
  })

  it("drops an incomplete Artifact and marks the card list incomplete", async () => {
    const workspace = owner("damaged-artifact")
    await seed(workspace)
    const key = chatExtrasKey(workspace, "conv")
    workspace.queryClient.setQueryData(key, (data: { conversation: unknown; artifacts: unknown[] }) => ({ ...data, artifacts: [{ id: "artifact", conversation_id: "conv", filename: "bad.pdf", content_type: "application/pdf" }], hasMoreArtifacts: false }))
    const scrubbed = scrubApplicationClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(workspace.queryClient) }, workspace.application.userId)
    expect(scrubbed.clientState.queries.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(key))?.state.data).toMatchObject({ artifacts: [], hasMoreArtifacts: true })
    workspace.queryClient.clear()
  })

  it("rejects foreign account snapshots in the application payload", async () => {
    const foreign = owner("foreign-account")
    await seed(foreign)
    const persister = createIdbPersister("current-account", "application")
    await save(foreign.queryClient, persister, true)
    expect((await persister.restoreClient())?.clientState.queries).toHaveLength(0)
    foreign.queryClient.clear()
  })
})
