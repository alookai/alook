import type { Artifact, Conversation, Message, TaskApi, TaskMessageResponse } from "@alook/shared"
import type { WorkspaceOwner } from "@/contexts/workspace-context"
import { captureQueryReceipt, isQueryReceiptCurrent } from "./query-receipt"
import { chatExtrasKey, chatMessagesKey, mergeCachedMessages, sortedChatMessages, type ChatExtras, type ChatMessagesData } from "./chat-cache"

export function captureChatLoad(owner: WorkspaceOwner) {
  return new Map(owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("chat") }).map((query) => [JSON.stringify(query.queryKey), { receipt: captureQueryReceipt(owner.queryClient, query.queryKey), liveRevision: (query.state.data as ChatMessagesData | undefined)?.liveRevision ?? 0 }]))
}
type ChatLoad = { conversation: Conversation; artifacts: Artifact[]; active_task: TaskApi | null; task_messages: TaskMessageResponse[]; messages?: Message[] | null; has_more_messages: boolean; has_more_artifacts: boolean; root_message?: Message | null }
export function settleChatLoad<T extends ChatLoad>(owner: WorkspaceOwner, data: T, tickets: ReturnType<typeof captureChatLoad>): T {
  const qc = owner.queryClient, id = data.conversation.id
  const eligible = (key: readonly unknown[]) => {
    const ticket = tickets.get(JSON.stringify(key))?.receipt
    return ticket ? isQueryReceiptCurrent(ticket) : !qc.getQueryCache().find({ queryKey: key, exact: true })
  }
  const extrasKey = chatExtrasKey(owner, id)
  const currentExtras = qc.getQueryData<ChatExtras>(extrasKey)
  const originalExtras = tickets.get(JSON.stringify(extrasKey))?.receipt.resource
  const sameExtras = originalExtras ? qc.getQueryCache().find({ queryKey: extrasKey, exact: true }) === originalExtras : !currentExtras || !currentExtras.conversation
  const extrasEligible = eligible(extrasKey)
  if (sameExtras) qc.setQueryData<ChatExtras>(extrasKey, (current) => extrasEligible
    ? { conversation: data.conversation, artifacts: data.artifacts, hasMoreArtifacts: data.has_more_artifacts }
    : { conversation: current?.conversation ?? data.conversation, artifacts: [...new Map([...data.artifacts, ...(current?.artifacts ?? [])].map((row) => [row.id, row])).values()], hasMoreArtifacts: current?.hasMoreArtifacts ?? data.has_more_artifacts })
  const messagesKey = chatMessagesKey(owner, id), currentMessages = qc.getQueryData<ChatMessagesData>(messagesKey)
  const messageTicket = tickets.get(JSON.stringify(messagesKey))
  const originalMessages = messageTicket?.receipt.resource
  const sameMessages = originalMessages ? qc.getQueryCache().find({ queryKey: messagesKey, exact: true }) === originalMessages : !currentMessages || (currentMessages.liveRevision ?? 0) > 0
  if (data.messages && sameMessages) {
    const rows = data.messages.filter((row) => (currentMessages?.liveMessageRevisions?.[row.id] ?? 0) <= (messageTicket?.liveRevision ?? 0))
    void mergeCachedMessages(id, rows, data.has_more_messages, owner).catch(() => undefined)
  }
  if (data.active_task) {
    const key = owner.key("chat", "task", data.active_task.id)
    if (eligible(key)) qc.setQueryData(key, data.active_task)
    const messagesKey = owner.key("chat", "task-messages", data.active_task.id)
    if (eligible(messagesKey)) qc.setQueryData(messagesKey, data.task_messages)
    else {
      const ticket = tickets.get(JSON.stringify(messagesKey))?.receipt
      if (!ticket || qc.getQueryCache().find({ queryKey: messagesKey, exact: true }) === ticket.resource) qc.setQueryData<TaskMessageResponse[]>(messagesKey, (rows) => [...new Map([...data.task_messages, ...(rows ?? [])].map((row) => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq))
    }
  }
  if (data.root_message) {
    const root = data.root_message, key = chatMessagesKey(owner, root.conversation_id)
    const ticket = tickets.get(JSON.stringify(key)), current = qc.getQueryData<ChatMessagesData>(key)
    const original = ticket?.receipt.resource
    if ((!original || qc.getQueryCache().find({ queryKey: key, exact: true }) === original) && (current?.liveMessageRevisions?.[root.id] ?? 0) <= (ticket?.liveRevision ?? 0)) void mergeCachedMessages(root.conversation_id, [root], null, owner).catch(() => undefined)
  }
  const activeKey = owner.key("chat", "active-task", id)
  if (eligible(activeKey)) qc.setQueryData(activeKey, { id: data.active_task?.id ?? null })
  const activeId = qc.getQueryData<{ id: string | null }>(activeKey)?.id
  const extras = qc.getQueryData<ChatExtras>(extrasKey)
  const messages = new Map(sortedChatMessages(qc.getQueryData<ChatMessagesData>(messagesKey)).map((row) => [row.id, row]))
  return { ...data, conversation: extras?.conversation ?? data.conversation, artifacts: extras?.artifacts ?? [], has_more_artifacts: extras?.hasMoreArtifacts ?? false,
    messages: data.messages?.flatMap((row) => messages.get(row.id) ?? []), active_task: activeId ? qc.getQueryData<TaskApi>(owner.key("chat", "task", activeId)) ?? null : null,
    task_messages: activeId ? qc.getQueryData<TaskMessageResponse[]>(owner.key("chat", "task-messages", activeId)) ?? [] : [],
  }
}
