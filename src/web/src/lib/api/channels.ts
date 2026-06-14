import type { Channel } from "@alook/shared";
import { apiFetch, wsQuery } from "./client";

export const listChannels = (workspaceId: string) =>
  apiFetch<Channel[]>(`/api/channels${wsQuery(workspaceId)}`);

export const createChannelApi = (workspaceId: string, name: string) =>
  apiFetch<Channel>(`/api/channels${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const renameChannelApi = (id: string, workspaceId: string, name: string) =>
  apiFetch<Channel>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteChannelApi = (id: string, workspaceId: string) =>
  apiFetch<{ ok: boolean }>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

export const reorderChannelsApi = (workspaceId: string, orderedChannelIds: string[]) =>
  apiFetch<void>(`/api/channels/reorder${wsQuery(workspaceId)}`, {
    method: "PUT",
    body: JSON.stringify({ ordered_channel_ids: orderedChannelIds }),
  });
