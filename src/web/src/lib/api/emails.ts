import type { Email } from "@alook/shared";
import { ApiError } from "@/lib/errors";
import { apiFetch, wsQuery } from "./client";

export const listEmails = (agentId: string, workspaceId: string, folder?: string, address?: string) =>
  apiFetch<Email[]>(`/api/email${wsQuery(workspaceId, { agentId, ...(folder ? { folder } : {}), ...(address ? { address } : {}) })}`);

export const getEmail = (id: string, workspaceId: string) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`);

export const getEmailThread = (id: string, workspaceId: string) =>
  apiFetch<Email[]>(`/api/email/${id}/thread${wsQuery(workspaceId)}`);

export const getEmailBody = async (id: string, workspaceId: string): Promise<{ content: string; isHtml: boolean }> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(`/api/email/${id}/body?${params}`, { credentials: "include" });
  if (!res.ok) return { content: "(body not available)", isHtml: false };
  const contentType = res.headers.get("Content-Type") ?? "";
  const content = await res.text();
  return { content, isHtml: contentType.includes("text/html") };
};

export const deleteEmail = (id: string, workspaceId: string) =>
  apiFetch<void>(`/api/email/${id}${wsQuery(workspaceId)}`, { method: "DELETE" });

export const updateEmailStatus = (id: string, workspaceId: string, status: string) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

export const trustEmail = (id: string, workspaceId: string) =>
  apiFetch<{ ok: boolean; email: Email; conversationId: string }>(
    `/api/email/${id}/trust${wsQuery(workspaceId)}`,
    { method: "POST" }
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
    const msg = await res.text().catch(() => "Upload failed");
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
) =>
  apiFetch<Email>(`/api/email/send${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ agentId, to, subject, htmlBody, attachments, ...threading, customAccountId }),
  });
