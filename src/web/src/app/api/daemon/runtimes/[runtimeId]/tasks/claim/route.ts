import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";

export const POST = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const runtimeId = ctx.params?.runtimeId;
  if (!runtimeId) {
    return writeError("runtime_id is required", 400);
  }

  const taskService = new TaskService(db);
  const task = await taskService.claimTaskForRuntime(runtimeId);

  if (!task) {
    return writeJSON({ task: null });
  }

  const agent = await queries.agent.getAgent(db, task.agentId, task.workspaceId);

  return writeJSON({
    task: {
      ...taskToResponse(task),
      agent: agent
        ? {
            instructions: agent.instructions,
            name: agent.name,
            runtime_config: agent.runtimeConfig || {},
          }
        : null,
    },
  });
});
