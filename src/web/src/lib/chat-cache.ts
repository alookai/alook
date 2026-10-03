import type { InfiniteData } from "@tanstack/react-query";
import type { Message, Artifact, Conversation } from "@alook/shared";
import { assertWorkspaceOwner, captureWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context";
import type { ApplicationOwner } from "@/lib/application-owner";

export type ChatMessagesPage = { messages: Message[]; hasMore: boolean; requestRevision?: number };
export type ChatMessagesData = InfiniteData<ChatMessagesPage> & { serverMessageCount: number; liveRevision?: number; liveMessageRevisions?: Record<string, number> };
export type ChatExtras = { conversation: Conversation | null; artifacts: Artifact[]; hasMoreArtifacts: boolean };
export interface CacheMeta {
  conversation_id: string;
  lastFetchedAt: number;
  lastAccessedAt: number;
  messageCount: number;
  newestMessageId: string | null;
  hasMore: boolean;
  serverMessageCount: number;
}
export interface LastOpenEntry {
  key: string;
  conversation_id: string;
  newestMessageId: string | null;
  serverMessageCount: number;
  updatedAt: number;
}
export interface ConvExtrasEntry {
  conversation_id: string;
  artifacts: Artifact[];
  conversation_type: string;
  conversation_title: string;
  conversation_channel: string;
  conversation_created_at: string;
  hasMoreArtifacts: boolean;
  updatedAt: number;
}
export const chatMessagesKey = (owner: WorkspaceOwner, conversationId: string) => owner.key("chat", "messages", conversationId);
export const chatExtrasKey = (owner: WorkspaceOwner, conversationId: string) => owner.key("chat", "extras", conversationId);
export const chatLatestKey = (owner: WorkspaceOwner, agentId: string, channel: string | null | undefined) => owner.key("chat", "latest-created", agentId, channel ?? "");
export function sortedChatMessages(data: ChatMessagesData | undefined): Message[] {
  const rows = new Map<string, Message>();
  for (const page of data?.pages ?? []) for (const row of page.messages) {
    if (!row.id.startsWith("temp-")) rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
function assertOwner(owner: WorkspaceOwner) { assertWorkspaceOwner(captureWorkspaceOwner(owner)); }
export async function getCachedMessages(conversationId: string, owner: WorkspaceOwner): Promise<Message[] | null> {
  assertOwner(owner);
  const messages = sortedChatMessages(owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(owner, conversationId)));
  return messages.length ? messages : null;
}
export async function getCacheMeta(conversationId: string, owner: WorkspaceOwner): Promise<CacheMeta | null> {
  assertOwner(owner);
  const key = chatMessagesKey(owner, conversationId);
  const data = owner.queryClient.getQueryData<ChatMessagesData>(key);
  if (!data) return null;
  const rows = sortedChatMessages(data);
  const updatedAt = owner.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
  return { conversation_id: conversationId, lastFetchedAt: updatedAt, lastAccessedAt: updatedAt, messageCount: rows.length, newestMessageId: rows.at(-1)?.id ?? null, hasMore: data.pages.at(-1)?.hasMore ?? true, serverMessageCount: data.serverMessageCount };
}
export async function mergeCachedMessages(conversationId: string, messages: Message[], hasMore: boolean | null, owner: WorkspaceOwner, serverMessageCount?: number, live = false): Promise<void> {
  assertOwner(owner);
  const valid = messages.filter((row) => !row.id.startsWith("temp-") && row.conversation_id === conversationId);
  owner.queryClient.setQueryData<ChatMessagesData>(chatMessagesKey(owner, conversationId), (previous) => {
    const liveRevision = (previous?.liveRevision ?? 0) + (live ? 1 : 0);
    const liveMessageRevisions = { ...previous?.liveMessageRevisions };
    if (live) for (const row of valid) liveMessageRevisions[row.id] = liveRevision;
    const byId = new Map(valid.map((row) => [row.id, row]));
    const present = new Set(sortedChatMessages(previous).map((row) => row.id));
    const pages = (previous?.pages ?? [{ messages: [], hasMore: true }]).map((page, index, all) => ({
      ...page,
      messages: [...page.messages.map((row) => byId.get(row.id) ?? row), ...(!index ? valid.filter((row) => !present.has(row.id)) : [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
      hasMore: index === all.length - 1 ? hasMore ?? page.hasMore : page.hasMore,
    }));
    return { pages, pageParams: previous?.pageParams ?? [null], serverMessageCount: serverMessageCount ?? previous?.serverMessageCount ?? 0, liveRevision, liveMessageRevisions };

  });
}
export async function appendCachedMessage(conversationId: string, message: Message, owner: WorkspaceOwner): Promise<void> {
  if (message.id.startsWith("temp-")) return;
  await mergeCachedMessages(conversationId, [message], null, owner, undefined, true);
}
export async function removeCachedMessage(conversationId: string, messageId: string, owner: WorkspaceOwner): Promise<void> {
  assertOwner(owner);
  owner.queryClient.setQueryData<ChatMessagesData>(chatMessagesKey(owner, conversationId), (data) => data ? { ...data, pages: data.pages.map((page) => ({ ...page, messages: page.messages.filter((row) => row.id !== messageId) })) } : undefined);
}
export async function getCachedMessagesBefore(conversationId: string, beforeCreatedAt: string, beforeId: string, limit: number, owner: WorkspaceOwner): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  const token = captureWorkspaceOwner(owner);
  const meta = await getCacheMeta(conversationId, owner);
  assertWorkspaceOwner(token);
  if (!meta) return null;
  const rows = sortedChatMessages(owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(owner, conversationId))).filter((row) => row.created_at < beforeCreatedAt || row.created_at === beforeCreatedAt && row.id < beforeId);
  if (rows.length < limit && meta.hasMore) return null;
  return { messages: rows.slice(-limit), hasMore: rows.length > limit || meta.hasMore };
}
export async function getLastOpenConversation(agentId: string, channel: string | null | undefined, owner: WorkspaceOwner): Promise<LastOpenEntry | null> {
  assertOwner(owner);
  return owner.queryClient.getQueryData<LastOpenEntry>(chatLatestKey(owner, agentId, channel)) ?? null;
}
export async function setLastOpenConversation(agentId: string, channel: string | null | undefined, entry: Pick<LastOpenEntry, "conversation_id" | "newestMessageId" | "serverMessageCount">, owner: WorkspaceOwner): Promise<void> {
  assertOwner(owner);
  owner.queryClient.setQueryData<LastOpenEntry>(chatLatestKey(owner, agentId, channel), { ...entry, key: `${agentId}::${channel ?? ""}`, updatedAt: Date.now() });
}
export async function clearLastOpenForConversation(conversationId: string, owner: WorkspaceOwner): Promise<void> {
  assertOwner(owner);
  owner.queryClient.removeQueries({ queryKey: owner.key("chat", "latest-created"), predicate: (query) => (query.state.data as LastOpenEntry | undefined)?.conversation_id === conversationId });
}
export async function getConvExtras(conversationId: string, owner: WorkspaceOwner): Promise<ConvExtrasEntry | null> {
  assertOwner(owner);
  const key = chatExtrasKey(owner, conversationId);
  const data = owner.queryClient.getQueryData<ChatExtras>(key);
  if (!data?.conversation) return null;
  return { conversation_id: conversationId, artifacts: data.artifacts, conversation_type: data.conversation.type, conversation_title: data.conversation.title, conversation_channel: data.conversation.channel, conversation_created_at: data.conversation.created_at, hasMoreArtifacts: data.hasMoreArtifacts, updatedAt: owner.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0 };
}
export async function setConvExtras(conversationId: string, entry: Omit<ConvExtrasEntry, "conversation_id" | "updatedAt">, owner: WorkspaceOwner): Promise<void> {
  assertOwner(owner);
  owner.queryClient.setQueryData<ChatExtras>(chatExtrasKey(owner, conversationId), (data) => ({ conversation: { ...data?.conversation, id: conversationId, agent_id: data?.conversation?.agent_id ?? "", type: entry.conversation_type, title: entry.conversation_title, channel: entry.conversation_channel, created_at: entry.conversation_created_at }, artifacts: entry.artifacts, hasMoreArtifacts: entry.hasMoreArtifacts }));
}
export async function clearConvExtras(conversationId: string, owner: WorkspaceOwner): Promise<void> {
  assertOwner(owner);
  owner.queryClient.removeQueries({ queryKey: chatExtrasKey(owner, conversationId), exact: true });
}
export async function invalidateCache(conversationId: string, owner: WorkspaceOwner): Promise<void> {
  const token = captureWorkspaceOwner(owner);
  assertWorkspaceOwner(token);
  await owner.queryClient.cancelQueries({ queryKey: chatMessagesKey(owner, conversationId), exact: true });
  assertWorkspaceOwner(token);
  owner.queryClient.removeQueries({ queryKey: chatMessagesKey(owner, conversationId), exact: true });
  await clearConvExtras(conversationId, owner);
  await clearLastOpenForConversation(conversationId, owner);
}
export async function clearAllCache(owner: ApplicationOwner): Promise<void> {
  await owner.queryClient.cancelQueries({ queryKey: ["application", owner.userId, "workspace"] });
  owner.queryClient.removeQueries({ queryKey: ["application", owner.userId, "workspace"] });
  await owner.retireDisk();
}
