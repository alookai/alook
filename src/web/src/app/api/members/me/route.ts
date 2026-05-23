import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, UpdateMemberRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const member = await queries.member.getMemberByUserAndWorkspace(
    db,
    ctx.userId,
    ws.workspaceId
  );
  if (!member) return writeError("member not found", 404);

  return writeJSON({ global_instruction: member.globalInstruction });
});

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const [body, err] = await parseBody(req, UpdateMemberRequestSchema);
  if (err) return err;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const updated = await queries.member.updateMemberGlobalInstruction(
    db,
    ctx.userId,
    ws.workspaceId,
    body.global_instruction
  );
  if (!updated) return writeError("member not found", 404);

  await Promise.all([
    invalidate(cacheKeys.member(ws.workspaceId, ctx.userId)),
    invalidate(cacheKeys.allMembers(ws.workspaceId)),
  ]);

  return writeJSON({ global_instruction: updated.globalInstruction });
});
