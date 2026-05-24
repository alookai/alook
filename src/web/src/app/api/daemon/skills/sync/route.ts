import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, SkillSyncRequestSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { parseBody, writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb, withD1Retry } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, err] = await parseBody(req, SkillSyncRequestSchema);
  if (err) return err;

  await withD1Retry(() =>
    queries.agentSkillCache.upsert(db, {
      workspaceId: ctx.workspaceId!,
      agentId: body.agent_id,
      runtime: body.runtime,
      skills: JSON.stringify(body.skills),
    })
  );

  return writeJSON({ status: "ok" });
});
