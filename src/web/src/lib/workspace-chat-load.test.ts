import { afterEach, describe, expect, it } from "vitest"
import type { Conversation, Message, TaskApi, WsMessage } from "@alook/shared"
import { createApplicationOwner } from "./application-owner"
import { createWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { captureChatLoad, settleChatLoad } from "./workspace-chat-load"
import { publishWorkspaceChatEvent } from "./workspace-chat-events"
import { chatExtrasKey, chatMessagesKey, sortedChatMessages, type ChatExtras, mergeCachedMessages } from "./chat-cache"

const owners: WorkspaceOwner[] = []
function owner() { const value = createWorkspaceOwner(createApplicationOwner("viewer"), "workspace", "workspace"); owners.push(value); return value }
const conversation: Conversation = { id: "conv", agent_id: "agent", title: "conversation", type: "agent_chat", channel: "general", created_at: "2026-10-01T00:00:00Z" }
const message: Message = { id: "message", conversation_id: "conv", role: "assistant", content: "HTTP", task_id: "task", attachment_ids: null, created_at: "2026-10-01T00:00:01Z" }
const task: TaskApi = { id: "task", agent_id: "agent", runtime_id: "runtime", conversation_id: "conv", workspace_id: "workspace", prompt: "hello", status: "queued", priority: 0, dispatched_at: null, started_at: null, completed_at: null, result: null, error: null, created_at: "2026-10-01T00:00:00Z", type: "chat" }
const response = () => ({ conversation, artifacts: [], active_task: task, task_messages: [], messages: [message], has_more_messages: false, has_more_artifacts: false })
afterEach(() => { for (const value of owners.splice(0)) value.queryClient.clear() })

describe("canonical chat load and central workspace WS", () => {
  it("retains a message and task updated by WS while the init response is held", async () => {
    const value = owner(), qc = value.queryClient
    qc.setQueryData(value.key("chat", "task", "task"), task)
    qc.setQueryData(chatExtrasKey(value, "conv"), { conversation, artifacts: [], hasMoreArtifacts: false } satisfies ChatExtras)
    await mergeCachedMessages("conv", [message], false, value)
    const tickets = captureChatLoad(value)
    publishWorkspaceChatEvent(value, { type: "conversation.message", conversationId: "conv", message: { ...message, content: "new WS" } } as WsMessage)
    publishWorkspaceChatEvent(value, { type: "task.updated", taskId: "task", status: "completed" } as WsMessage)
    const result = settleChatLoad(value, response(), tickets)
    expect(result.messages).toMatchObject([{ content: "new WS" }])
    expect(result.active_task?.status).toBe("completed")
    expect(sortedChatMessages(qc.getQueryData(chatMessagesKey(value, "conv")))).toMatchObject([{ content: "new WS" }])
  })

  it("publishes WS into canonical resources even before a chat panel opens", () => {
    const value = owner(), tickets = captureChatLoad(value)
    publishWorkspaceChatEvent(value, { type: "task.created", conversationId: "conv", task: { ...task, status: "running" } } as WsMessage)
    publishWorkspaceChatEvent(value, { type: "conversation.message", conversationId: "conv", message: { ...message, content: "first WS" } } as WsMessage)
    const result = settleChatLoad(value, response(), tickets)
    expect(result.active_task?.status).toBe("running")
    expect(result.messages).toMatchObject([{ content: "first WS" }])
  })

  it("does not overwrite a recreated conversation or task resource", async () => {
    const value = owner(), qc = value.queryClient
    qc.setQueryData(chatExtrasKey(value, "conv"), { conversation, artifacts: [], hasMoreArtifacts: false })
    qc.setQueryData(value.key("chat", "task", "task"), task)
    await mergeCachedMessages("conv", [message], false, value)
    const tickets = captureChatLoad(value)
    qc.removeQueries({ queryKey: value.key("chat") })
    qc.setQueryData(chatExtrasKey(value, "conv"), { conversation: { ...conversation, title: "replacement" }, artifacts: [], hasMoreArtifacts: false })
    qc.setQueryData(value.key("chat", "task", "task"), { ...task, status: "failed" })
    await mergeCachedMessages("conv", [{ ...message, content: "replacement" }], false, value)
    settleChatLoad(value, response(), tickets)
    expect(qc.getQueryData<ChatExtras>(chatExtrasKey(value, "conv"))?.conversation?.title).toBe("replacement")
    expect(qc.getQueryData<TaskApi>(value.key("chat", "task", "task"))?.status).toBe("failed")
    expect(sortedChatMessages(qc.getQueryData(chatMessagesKey(value, "conv")))[0].content).toBe("replacement")
  })
})
