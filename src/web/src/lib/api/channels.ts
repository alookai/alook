import type { Channel } from "@alook/shared";
import { apiFetch, wsQuery } from "./client";

export const listChannels = (workspaceId: string, options?: RequestInit) =>
  apiFetch<Channel[]>(`/api/channels${wsQuery(workspaceId)}`, options);

export const createChannelApi = (workspaceId: string, name: string, options?: RequestInit) =>
  apiFetch<Channel>(`/api/channels${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const renameChannelApi = (id: string, workspaceId: string, name: string, options?: RequestInit) =>
  apiFetch<Channel>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteChannelApi = (id: string, workspaceId: string, options?: RequestInit) =>
  apiFetch<{ ok: boolean }>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
  });

export const reorderChannelsApi = (workspaceId: string, orderedChannelIds: string[], options?: RequestInit) =>
  apiFetch<void>(`/api/channels/reorder${wsQuery(workspaceId)}`, {
    ...options,
    method: "PUT",
    body: JSON.stringify({ ordered_channel_ids: orderedChannelIds }),
  });
