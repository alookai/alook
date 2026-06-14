import type { TaskApi, TaskMessageResponse } from "@alook/shared";
import { apiFetch, wsQuery } from "./client";

export const getTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}${wsQuery(workspaceId)}`);

export const getTaskMessages = (id: string, workspaceId: string, since?: number) =>
  apiFetch<TaskMessageResponse[]>(
    `/api/tasks/${id}/messages${wsQuery(workspaceId, since ? { since: String(since) } : undefined)}`
  );

export const retryTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}/retry${wsQuery(workspaceId)}`, {
    method: "POST",
  });
