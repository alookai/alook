import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { workspaceToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("workspace id is required", 400);
  }

  const workspace = await queries.workspace.getWorkspace(db, id);
  if (!workspace) {
    return writeError("workspace not found", 404);
  }

  return writeJSON(workspaceToResponse(workspace));
});
