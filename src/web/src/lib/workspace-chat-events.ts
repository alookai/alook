import type { TaskApi, TaskMessageResponse, WsMessage } from "@alook/shared"
import { assertWorkspaceOwner, captureWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { appendCachedMessage, chatExtrasKey, type ChatExtras } from "./chat-cache"

export function publishWorkspaceChatEvent(owner: WorkspaceOwner, message: WsMessage) {
  const token = captureWorkspaceOwner(owner)
  assertWorkspaceOwner(token)
  const qc = owner.queryClient
  if (message.type === "task.created") {
    const task = message.task as TaskApi
    qc.setQueryData(owner.key("chat", "task", task.id), task)
    qc.setQueryData(owner.key("chat", "active-task", message.conversationId), { id: task.id })
  } else if (message.type === "task.updated") {
    qc.setQueryData<TaskApi>(owner.key("chat", "task", message.taskId), (task) => task ? { ...task, status: message.status } : task)
  } else if (message.type === "task.messages") {
    qc.setQueryData<TaskMessageResponse[]>(owner.key("chat", "task-messages", message.taskId), (rows) => [...new Map([...(rows ?? []), ...message.messages].map((row) => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq))
  } else if (message.type === "conversation.message") {
    void appendCachedMessage(message.conversationId, message.message, owner).catch(() => undefined)
  } else if (message.type === "artifact.uploaded") {
    qc.setQueryData<ChatExtras>(chatExtrasKey(owner, message.conversationId), (data) => ({ conversation: data?.conversation ?? null, artifacts: [...new Map([...(data?.artifacts ?? []), message.artifact].map((row) => [row.id, row])).values()], hasMoreArtifacts: data?.hasMoreArtifacts ?? false }))
  }
}
