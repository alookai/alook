import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceOwner } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { inviteToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const owner = await withWorkspaceOwner(req, ctx);
  if (owner instanceof Response) return owner;

  const db = getDb(ctx.env.DB);

  const invites = await queries.workspaceInvite.listActiveInvites(db, owner.workspaceId);
  return writeJSON(invites.map(inviteToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const owner = await withWorkspaceOwner(req, ctx);
  if (owner instanceof Response) return owner;

  const db = getDb(ctx.env.DB);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const invite = await queries.workspaceInvite.createInvite(db, {
    workspaceId: owner.workspaceId,
    createdBy: ctx.userId,
    expiresAt,
  });
  return writeJSON(inviteToResponse(invite), 201);
});
