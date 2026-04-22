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

  const { memberId } = ctx.params!;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const members = await queries.member.listMembers(db, owner.workspaceId);
  const target = members.find((m: any) => m.id === memberId);
  if (!target) return writeError("member not found", 404);
  if (target.userId === ctx.userId) return writeError("cannot remove yourself", 400);

  const deleted = await queries.member.deleteMember(db, memberId, owner.workspaceId);
  if (!deleted) return writeError("member not found", 404);

  return new Response(null, { status: 204 });
});
