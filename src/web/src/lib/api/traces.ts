import { apiFetch, wsQuery } from "./client";

export interface TraceListItem {
  trace_id: string;
  root_prompt: string;
  root_agent_id: string;
  root_agent: { name: string; avatarUrl: string | null } | null;
  helper_agents: { id: string; name?: string; avatarUrl?: string | null }[];
  status: string;
  task_count: number;
  started_at: string;
  completed_at: string | null;
  channel: string;
}

export interface TraceTask {
  id: string;
  agent_id: string;
  agent: { name: string; email_handle: string | null; avatarUrl: string | null } | null;
  parent_task_id: string | null;
  prompt: string;
  status: string;
  type: string;
  conversation_id: string;
  created_at: string;
  completed_at: string | null;
}

export const listTraces = (
  workspaceId: string,
  opts?: { status?: string; limit?: number; before?: string; multiAgent?: boolean; agentId?: string; channel?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.status) extra.status = opts.status;
  if (opts?.multiAgent) extra.multiAgent = "true";
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.channel) extra.channel = opts.channel;
  return apiFetch<{ traces: TraceListItem[]; has_more: boolean }>(
    `/api/traces${wsQuery(workspaceId, extra)}`
  );
};

export const getTrace = (traceId: string, workspaceId: string) =>
  apiFetch<{ trace_id: string; channel: string; tasks: TraceTask[] }>(
    `/api/traces/${traceId}${wsQuery(workspaceId)}`
  );
