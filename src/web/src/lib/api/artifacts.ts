import type { Artifact } from "@alook/shared";
import { apiFetch, wsQuery } from "./client";

export const listArtifacts = (conversationId: string, workspaceId: string) =>
  apiFetch<Artifact[]>(`/api/artifacts${wsQuery(workspaceId, { conversation_id: conversationId })}`);

export const getArtifactContent = async (id: string, workspaceId: string): Promise<string> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(`/api/artifacts/${id}/content?${params}`, { credentials: "include" });
  if (!res.ok) return "(content not available)";
  return res.text();
};
