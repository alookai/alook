import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("token id is required", 400);
  }

  const tokens = await queries.machineToken.listMachineTokens(db, ctx.userId, ws.workspaceId);
  const target = tokens.find((t) => t.id === id);

  await queries.machineToken.deleteMachineToken(db, id, ctx.userId);

  if (target) {
    await invalidate(cacheKeys.machineToken(target.token));
  }

  return new Response(null, { status: 204 });
});
