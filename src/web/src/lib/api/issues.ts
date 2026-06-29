import type {
  Artifact,
  Issue,
  IssueComment,
  Message,
  CreateIssueRequest,
  TaskApi,
  UpdateIssueRequest,
} from "@alook/shared";
import { ApiError } from "@/lib/errors";
import { apiFetch, wsQuery } from "./client";

export type IssueListItem = Issue & { thread_agent_ids?: string[] };

export interface IssueDetailResponse {
  issue: Issue & { trace_id?: string | null };
  messages: Message[];
  comments: IssueComment[];
  artifacts: Artifact[];
}

export const listIssues = (
  workspaceId: string,
  opts?: { agentId?: string; status?: string; terminal?: boolean }
) => {
  const extra: Record<string, string> = {};
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.status) extra.status = opts.status;
  if (opts?.terminal !== undefined) extra.terminal = String(opts.terminal);
  return apiFetch<IssueListItem[]>(`/api/issues${wsQuery(workspaceId, extra)}`);
};

export const createIssue = async (
  workspaceId: string,
  req: CreateIssueRequest & { files?: File[] },
): Promise<{ issue: Issue; message?: Message; task?: TaskApi }> => {
  if (!req.files || req.files.length === 0) {
    return apiFetch<{ issue: Issue; message?: Message; task?: TaskApi }>(`/api/issues${wsQuery(workspaceId)}`, {
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

  let res: Response;
  try {
    res = await fetch(`/api/issues${wsQuery(workspaceId)}`, {
      method: "POST",
      credentials: "include",
      body: fd,
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError("Unable to connect — check your network", 0);
    }
    throw err;
  }

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/sign-in";
    throw new ApiError("Unauthorized", 401);
  }

  if (!res.ok) {
    let serverError: string | undefined;
    let details: string[] | undefined;
    try {
      const body = (await res.json()) as { error?: string; details?: string[] };
      serverError = body.error;
      details = body.details;
    } catch {
      // non-JSON body
    }
    if (res.status === 429) throw new ApiError("Please wait a moment before trying again", 429);
    if (res.status >= 500) throw new ApiError(serverError || "Something went wrong — please try again", res.status, details);
    throw new ApiError(serverError || "Something went wrong", res.status, details);
  }

  return res.json() as Promise<{ issue: Issue; message?: Message; task?: TaskApi }>;
};

export const getIssue = (workspaceId: string, issueId: string) =>
  apiFetch<IssueDetailResponse>(`/api/issues/${issueId}${wsQuery(workspaceId)}`);

export const updateIssue = (workspaceId: string, issueId: string, patch: UpdateIssueRequest) =>
  apiFetch<Issue>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const commentIssue = (workspaceId: string, issueId: string, content: string) =>
  apiFetch<{ message: Message }>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const deleteIssue = (workspaceId: string, issueId: string) =>
  apiFetch<void>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, { method: "DELETE" });
