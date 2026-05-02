import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((id: unknown) => typeof id === "string");
}

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const body = (await req.json()) as { pinnedIds?: unknown; unpinnedIds?: unknown };
  const { pinnedIds, unpinnedIds } = body;
  if (!isStringArray(pinnedIds) || !isStringArray(unpinnedIds)) {
    return writeError("pinnedIds and unpinnedIds must be string arrays", 400);
  }
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);
  await queries.agentPin.reorderPins(db, ws.workspaceId, ctx.userId, pinnedIds, unpinnedIds);
  return writeJSON({ ok: true });
});
