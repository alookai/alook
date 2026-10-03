import type { TaskApi, TaskMessageResponse } from "@alook/shared";
import type { ApiRequestOptions } from "./client";
import { apiFetch, wsQuery } from "./client";

export const getTask = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<TaskApi>(`/api/tasks/${id}${wsQuery(workspaceId)}`, options);

export const getTaskMessages = (id: string, workspaceId: string, since?: number, options?: ApiRequestOptions) =>
  apiFetch<TaskMessageResponse[]>(
    `/api/tasks/${id}/messages${wsQuery(workspaceId, since ? { since: String(since) } : undefined)}`, options,
  );

export const retryTask = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<TaskApi>(`/api/tasks/${id}/retry${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
  });
