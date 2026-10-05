import { readApiResponse } from "./client";
import type { Artifact } from "@alook/shared";
import type { ApiRequestOptions } from "./client";
import { apiFetch, apiFetchResponse, wsQuery } from "./client";

export const listArtifacts = (conversationId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<Artifact[]>(`/api/artifacts${wsQuery(workspaceId, { conversation_id: conversationId })}`, options);

export const getArtifactContent = async (id: string, workspaceId: string, options?: ApiRequestOptions): Promise<string> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await apiFetchResponse(`/api/artifacts/${id}/content?${params}`, options, true);
  const text = await readApiResponse<string>(res, "text", options);
  options?.assertActive?.();
  if (options?.signal?.aborted) throw new DOMException("Retired artifact content", "AbortError");
  return text;
};
