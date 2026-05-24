import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb } from "@/lib/db";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id required", 400);

  const workspaceId = new URL(req.url).searchParams.get("workspace_id");
  if (!workspaceId) return writeError("workspace_id required", 400);

  const agent = await queries.agent.getAgent(db, agentId, workspaceId);
  if (!agent) return writeError("agent not found", 404);

  let runtime = "claude";
  if (agent.runtimeId) {
    const rt = await queries.runtime.getAgentRuntime(db, agent.runtimeId);
    if (rt) runtime = rt.provider;
  }

  const row = await queries.agentSkillCache.getByAgentRuntime(db, agentId, runtime);
  const skills = row ? JSON.parse(row.skills) : [];

  return writeJSON({ skills });
});
