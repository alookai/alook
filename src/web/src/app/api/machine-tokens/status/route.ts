import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const token = await queries.machineToken.getLatestTokenForUser(db, ctx.userId);
  if (!token) {
    return writeJSON({ status: null });
  }

  return writeJSON({
    status: token.status,
    workspace_id: token.workspaceId || undefined,
    hostname: token.hostname || undefined,
  });
});
