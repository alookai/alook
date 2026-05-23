import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const messageId = ctx.params?.messageId;
  if (!messageId) {
    return new Response(null, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  await queries.messageFlag.unflagMessage(db, messageId, ctx.userId, ws.workspaceId);
  return new Response(null, { status: 204 });
});
