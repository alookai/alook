import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const body = (await req.json()) as { agentIds?: unknown };
  const { agentIds } = body;
  if (!Array.isArray(agentIds) || !agentIds.every((id: unknown) => typeof id === "string")) {
    return writeError("agentIds must be a string array", 400);
  }
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);
  await queries.agentPin.reorderPins(db, ws.workspaceId, ctx.userId, agentIds);
  return writeJSON({ ok: true });
});
