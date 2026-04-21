import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, PollRequestSchema, semverGte } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { sweepStaleState } from "@/lib/services/sweep";
import { promoteDueCalendarEventsForWorkspace } from "@/lib/services/calendar";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, err] = await parseBody(req, PollRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  // 1. Resolve runtime IDs from daemon_id + workspaceId
  const runtimeIds = await queries.runtime.getRuntimeIdsByDaemon(
    db,
    body.daemon_id,
    ctx.workspaceId,
  );

  if (runtimeIds.length === 0) {
    return writeJSON({ tasks: [], evicted: true });
  }

  // 2. Liveness: upsert machine row only when runtimes exist
  await queries.machine.upsertMachine(db, {
    daemonId: body.daemon_id,
    workspaceId: ctx.workspaceId,
    deviceInfo: body.daemon_id,
  });

  broadcastToUser(ctx.userId, {
    type: "runtime.status",
    daemonId: body.daemon_id,
    workspaceId: ctx.workspaceId,
    status: "online",
  }).catch(() => {});

  // 3. Housekeeping: sweep stale state
  await sweepStaleState(db, ctx.workspaceId);

  // 3b. Promote due calendar events into queued tasks before task claiming so
  // they are eligible in the same poll response.
  try {
    const enqueued = await promoteDueCalendarEventsForWorkspace(
      db,
      ctx.workspaceId,
    );
    if (enqueued > 0) {
      log.info("calendar: enqueued", { workspaceId: ctx.workspaceId, enqueued });
    }
  } catch (err) {
    log.warn("calendar: promote failed", {
      workspaceId: ctx.workspaceId,
      err: String(err),
    });
  }

  // 4. Task claiming
  const taskService = new TaskService(db);
  const claimed = await taskService.claimTasksForRuntimes(
    runtimeIds,
    body.max_tasks,
    ctx.workspaceId!,
  );

  const tasks = [];
  // Per-request cache: avoids duplicate DB reads when multiple agents share the same owner
  const memberCache = new Map<string, { globalInstruction: string } | null>();
  for (const task of claimed) {
    const agent = await queries.agent.getAgent(db, task.agentId, task.workspaceId);
    let emailAddresses: string[] = [];
    if (agent) {
      if (agent.emailHandle) emailAddresses.push(`${agent.emailHandle}@alook.ai`);
      const customAccounts = await queries.emailAccount.getEmailAccountsByAgent(db, agent.id, task.workspaceId);
      for (const acc of customAccounts) {
        emailAddresses.push(acc.emailAddress);
      }
    }

    let instructions = agent?.instructions ?? "";
    if (agent?.ownerId) {
      if (!memberCache.has(agent.ownerId)) {
        const m = await queries.member.getMemberByUserAndWorkspace(
          db,
          agent.ownerId,
          task.workspaceId,
        );
        memberCache.set(agent.ownerId, m ? { globalInstruction: m.globalInstruction } : null);
      }
      const cached = memberCache.get(agent.ownerId);
      if (cached?.globalInstruction) {
        instructions = [cached.globalInstruction, instructions].filter(Boolean).join("\n\n");
      }
    }

    tasks.push({
      ...taskToResponse(task),
      agent: agent
        ? {
            instructions,
            name: agent.name,
            runtime_config: agent.runtimeConfig || {},
            email_handle: agent.emailHandle || null,
            email_addresses: emailAddresses,
            user_email: ctx.email || null,
          }
        : null,
    });
  }

  // 5. Pending update check
  const machineRow = await queries.machine.getMachineByDaemon(
    db,
    body.daemon_id,
    ctx.workspaceId,
  );
  let pendingUpdate: { version: string } | undefined;
  if (machineRow?.pendingUpdateVersion && body.cli_version) {
    if (semverGte(body.cli_version, machineRow.pendingUpdateVersion)) {
      await queries.machine.clearPendingUpdateVersion(db, body.daemon_id);
      broadcastToUser(ctx.userId, {
        type: "runtime.status",
        daemonId: body.daemon_id,
        workspaceId: ctx.workspaceId,
        status: "online",
      }).catch(() => {});
    } else {
      pendingUpdate = { version: machineRow.pendingUpdateVersion };
    }
  }

  return writeJSON({ tasks, ...(pendingUpdate && { pending_update: pendingUpdate }) });
});
