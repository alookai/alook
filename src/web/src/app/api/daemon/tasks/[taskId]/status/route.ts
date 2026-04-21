import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const status = await queries.task.getTaskStatus(db, taskId, ctx.workspaceId);
  if (!status) {
    return writeError("task not found", 404);
  }

  return writeJSON({ status });
});
