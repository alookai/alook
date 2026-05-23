import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { invalidateInboxCounts } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  await queries.inbox.markAllConversationsRead(db, ctx.userId, ws.workspaceId);
  invalidateInboxCounts(ctx.userId, ws.workspaceId).catch(() => {});

  return new NextResponse(null, { status: 204 });
});
