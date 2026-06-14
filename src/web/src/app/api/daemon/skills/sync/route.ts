import { NextRequest } from "next/server";
import { queries, SkillSyncRequestSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { parseBody, writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb, withD1Retry } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const db = getDb(ctx.env.DB);

  const [body, err] = await parseBody(req, SkillSyncRequestSchema);
  if (err) return err;

  if (body.scope === "global") {
    await withD1Retry(() =>
      queries.agentSkill.syncGlobalSkills(
        db,
        ctx.workspaceId!,
        body.runtime,
        body.skills,
        body.daemon_id,
      )
    );
  } else {
    if (!body.agent_id) return writeError("agent_id required for agent scope", 400);
    await withD1Retry(() =>
      queries.agentSkill.syncAgentSkills(
        db,
        body.agent_id!,
        body.runtime,
        ctx.workspaceId!,
        body.skills,
      )
    );
  }

  return writeJSON({ status: "ok" });
});
