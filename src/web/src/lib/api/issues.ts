import { readApiResponse } from "./client";
import type {
Artifact,
Issue,
IssueComment,
Message,
CreateIssueRequest,
TaskApi,
UpdateIssueRequest,
} from "@alook/shared";
import { apiFetch,apiFetchResponse,wsQuery,type ApiRequestOptions } from "./client";

export type IssueListItem = Issue & { thread_agent_ids?: string[] };

export interface IssueDetailResponse {
  issue: Issue & { trace_id?: string | null };
  messages: Message[];
  comments: IssueComment[];
  artifacts: Artifact[];
}

export const listIssues = (
  workspaceId: string,
  opts?: { agentId?: string; status?: string; terminal?: boolean },
  options?: ApiRequestOptions
) => {
  const extra: Record<string, string> = {};
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.status) extra.status = opts.status;
  if (opts?.terminal !== undefined) extra.terminal = String(opts.terminal);
  return apiFetch<IssueListItem[]>(`/api/issues${wsQuery(workspaceId, extra)}`, options);
};

export const createIssue = async (
  workspaceId: string,
  req: CreateIssueRequest & { files?: File[] },
  options?: ApiRequestOptions,
): Promise<{ issue: Issue; message?: Message; task?: TaskApi }> => {
  if (!req.files || req.files.length === 0) {
    return apiFetch<{ issue: Issue; message?: Message; task?: TaskApi }>(`/api/issues${wsQuery(workspaceId)}`, {
      ...options,
      method: "POST",
      body: JSON.stringify({
        agent_id: req.agent_id,
        title: req.title,
        description: req.description,
      }),
    });
  }

  const fd = new FormData();
  if (req.agent_id) fd.append("agent_id", req.agent_id);
  fd.append("title", req.title);
  fd.append("description", req.description ?? "");
  for (const file of req.files) {
    fd.append("file", file);
  }

  const res = await apiFetchResponse(`/api/issues${wsQuery(workspaceId)}`, { ...options, method: "POST", body: fd }, true);
  const data = await readApiResponse(res, "json", options) as { issue: Issue; message?: Message; task?: TaskApi };
  options?.assertActive?.();
  if (options?.signal?.aborted) throw new DOMException("Cancelled issue upload", "AbortError");
  return data;
};

export const getIssue = (workspaceId: string, issueId: string, options?: ApiRequestOptions) =>
  apiFetch<IssueDetailResponse>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, options);

export const updateIssue = (workspaceId: string, issueId: string, patch: UpdateIssueRequest, options?: ApiRequestOptions) =>
  apiFetch<Issue>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const createIssueComment = (workspaceId: string, issueId: string, content: string, options?: ApiRequestOptions) =>
  apiFetch<{ comment: IssueComment }>(`/api/issues/${issueId}/comments${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const deleteIssue = (workspaceId: string, issueId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });
