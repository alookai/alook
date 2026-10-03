import type {
  CalendarEvent,
  CreateCalendarEventRequest,
  UpdateCalendarEventRequest,
  DeleteCalendarEventRequest,
} from "@alook/shared";
import { apiFetch, wsQuery, type ApiRequestOptions } from "./client";

export const listCalendarEvents = (
  workspaceId: string,
  opts?: { agentId?: string; from?: string; to?: string },
  options?: ApiRequestOptions
) => {
  const extra: Record<string, string> = {};
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.from) extra.from = opts.from;
  if (opts?.to) extra.to = opts.to;
  return apiFetch<CalendarEvent[]>(`/api/calendar${wsQuery(workspaceId, extra)}`, options);
};

export const getCalendarEvent = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`, options);

export const createCalendarEvent = (
  req: CreateCalendarEventRequest,
  workspaceId: string,
  options?: ApiRequestOptions
) =>
  apiFetch<CalendarEvent>(`/api/calendar${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify(req),
  });

export const updateCalendarEvent = (
  id: string,
  patch: UpdateCalendarEventRequest,
  workspaceId: string,
  options?: ApiRequestOptions
) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const deleteCalendarEvent = (
  id: string,
  workspaceId: string,
  body?: DeleteCalendarEventRequest,
  options?: ApiRequestOptions
) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
    ...(body && body.scope
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
