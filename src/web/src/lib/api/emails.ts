import { readApiResponse } from "./client";
import type { Email } from "@alook/shared";
import { ApiError } from "@/lib/errors";
import { apiFetch, apiFetchResponse, wsQuery, type ApiRequestOptions } from "./client";

export const listEmails = (agentId: string, workspaceId: string, folder?: string, address?: string, options?: ApiRequestOptions) =>
  apiFetch<Email[]>(`/api/email${wsQuery(workspaceId, { agentId, ...(folder ? { folder } : {}), ...(address ? { address } : {}) })}`, options);

export const getEmail = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`, options);

export const getEmailThread = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<Email[]>(`/api/email/${id}/thread${wsQuery(workspaceId)}`, options);

export const getEmailBody = async (id: string, workspaceId: string, options?: ApiRequestOptions): Promise<{ content: string; isHtml: boolean }> => {
  let res: Response;
  try { res = await apiFetchResponse(`/api/email/${id}/body${wsQuery(workspaceId)}`, options, true); }
  catch (error) {
    options?.assertActive?.();
    if (error instanceof ApiError && error.status !== 401) return { content: "(body not available)", isHtml: false };
    throw error;
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  const content = await readApiResponse<string>(res, "text", options);
  options?.assertActive?.();
  if (options?.signal?.aborted) throw new DOMException("Cancelled request", "AbortError");
  return { content, isHtml: contentType.includes("text/html") };
};

export const deleteEmail = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/email/${id}${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });

export const updateEmailStatus = (id: string, workspaceId: string, status: string, options?: ApiRequestOptions) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

export const trustEmail = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ ok: boolean; email: Email; conversationId: string }>(
    `/api/email/${id}/trust${wsQuery(workspaceId)}`,
    { ...options, method: "POST" }
  );

export const uploadEmailAttachment = async (
  file: File,
  workspaceId: string,
): Promise<{ key: string; filename: string; size: number; contentType: string }> => {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/email/upload${wsQuery(workspaceId)}`, {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  if (!res.ok) {
    const msg = await readApiResponse<string>(res, "text").catch(() => "Upload failed");
    throw new ApiError(msg, res.status);
  }
  return res.json();
};

export const sendEmail = (
  agentId: string,
  to: string,
  subject: string,
  htmlBody: string,
  workspaceId: string,
  attachments?: { key: string; filename: string; size: number; contentType: string }[],
  threading?: { inReplyTo?: string; references?: string },
  customAccountId?: string,
  options?: ApiRequestOptions,
) =>
  apiFetch<Email>(`/api/email/send${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ agentId, to, subject, htmlBody, attachments, ...threading, customAccountId }),
  });
