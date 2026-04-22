import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceOwner } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const owner = await withWorkspaceOwner(req, ctx);
  if (owner instanceof Response) return owner;

  const { inviteId } = ctx.params!;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const deleted = await queries.workspaceInvite.deleteInvite(db, inviteId, owner.workspaceId);
  if (!deleted) return writeError("invite not found", 404);

  return new Response(null, { status: 204 });
});
