import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceOwner } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const owner = await withWorkspaceOwner(req, ctx);
  if (owner instanceof Response) return owner;

  const { memberId } = ctx.params!;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const target = await queries.member.getMember(db, memberId, owner.workspaceId);
  if (!target) return writeError("member not found", 404);
  if (target.userId === ctx.userId) return writeError("cannot remove yourself", 400);
  if (target.role === "owner") return writeError("cannot remove a workspace owner", 403);

  await queries.member.deleteMember(db, memberId, owner.workspaceId);
  await invalidate(cacheKeys.member(owner.workspaceId, target.userId));

  return new Response(null, { status: 204 });
});
