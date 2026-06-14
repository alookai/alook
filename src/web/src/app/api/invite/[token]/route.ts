import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const { token } = ctx.params!;

  const db = getDb(ctx.env.DB);

  const invite = await queries.workspaceInvite.getInviteByToken(db, token);
  if (!invite) return writeError("invite not found", 404);
  if (invite.usedBy) return writeError("invite already used", 410);
  if (new Date(invite.expiresAt) < new Date()) return writeError("invite expired", 410);

  return writeJSON({
    workspace_name: invite.workspaceName,
    workspace_id: invite.workspaceId,
    invited_by: invite.creatorName || invite.creatorEmail,
  });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { token } = ctx.params!;

  const db = getDb(ctx.env.DB);

  const invite = await queries.workspaceInvite.getInviteByToken(db, token);
  if (!invite) return writeError("invite not found", 404);
  if (invite.usedBy) return writeError("invite already used", 410);
  if (new Date(invite.expiresAt) < new Date()) return writeError("invite expired", 410);

  const existing = await queries.member.getMemberByUserAndWorkspace(db, ctx.userId, invite.workspaceId);
  if (existing) return writeError("already a member of this workspace", 409);

  const redeemed = await queries.workspaceInvite.redeemInvite(db, token, ctx.userId);
  if (!redeemed) return writeError("invite already used", 410);

  await queries.member.createMember(db, {
    workspaceId: invite.workspaceId,
    userId: ctx.userId,
    role: "member",
  });

  await invalidate(cacheKeys.allMembers(invite.workspaceId));

  return writeJSON({ workspace_id: invite.workspaceId, workspace_slug: invite.workspaceSlug });
});
