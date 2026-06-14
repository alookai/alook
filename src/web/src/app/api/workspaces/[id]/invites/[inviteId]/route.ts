import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceOwner } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const owner = await withWorkspaceOwner(req, ctx);
  if (owner instanceof Response) return owner;

  const { inviteId } = ctx.params!;

  const db = getDb(ctx.env.DB);

  const deleted = await queries.workspaceInvite.deleteInvite(db, inviteId, owner.workspaceId);
  if (!deleted) return writeError("invite not found", 404);

  return new Response(null, { status: 204 });
});
