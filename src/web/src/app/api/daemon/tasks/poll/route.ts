import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, PollRequestSchema, semverGte, type FileRequestItem, type PollMeetingItem } from "@alook/shared";
import { getDb, withD1Retry } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { TaskService } from "@/lib/services/task";
import { TaskPayloadBuilder } from "@/lib/services/task-payload-builder";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const { cached, cacheKeys, throttled } = await import("@/lib/cache");

  const [body, err] = await parseBody(req, PollRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  // 1. Resolve runtime IDs from daemon_id + workspaceId (cached 10min)
  const runtimeIds = await cached(
    cacheKeys.runtimeIds(ctx.workspaceId, body.daemon_id),
    600,
    () => queries.runtime.getRuntimeIdsByDaemon(db, body.daemon_id, ctx.workspaceId!),
  );

  if (runtimeIds.length === 0) {
    return writeJSON({ tasks: [], evicted: true });
  }

  // 2. Task claiming
  const taskService = new TaskService(db);
  const claimed = await withD1Retry(() => taskService.claimTasksForRuntimes(
    runtimeIds,
    body.max_tasks,
    ctx.workspaceId!,
  ));

  const payloadBuilder = new TaskPayloadBuilder(db);
  const tasks = await payloadBuilder.buildFullPayloads(claimed, ctx.workspaceId!);

  // Patch user_email (only available in poll context via auth)
  for (const t of tasks) {
    if (t.agent) t.agent.user_email = ctx.email || null;
  }

  // 3. Pending update & rescan check + meeting claim — throttled to once per 30s
  let pendingUpdate: { version: string } | undefined;
  let pendingRescan: boolean | undefined;
  let meetings: PollMeetingItem[] | undefined;
  const miscKey = `misc:${ctx.workspaceId}:${body.daemon_id}`;
  let runMisc = false;
  try {
    runMisc = await throttled(miscKey, 30, async () => {});
  } catch { runMisc = true; }

  if (runMisc) {
    try {
      const machineRow = await queries.machine.getMachineByDaemon(
        db,
        body.daemon_id,
        ctx.workspaceId,
      );
      if (machineRow?.pendingUpdateVersion && body.cli_version) {
        if (semverGte(body.cli_version, machineRow.pendingUpdateVersion)) {
          await queries.machine.clearPendingUpdateVersion(db, body.daemon_id, ctx.workspaceId);
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

      if (machineRow?.pendingRescan) {
        pendingRescan = true;
        await queries.machine.clearPendingRescan(db, body.daemon_id, ctx.workspaceId);
      }
    } catch (e) {
      log.warn("pending check failed", { daemonId: body.daemon_id, err: String(e) });
    }

    // Meeting claim — 5min claim window, 30s throttle is safe
    try {
      const CLAIM_WINDOW_MS = 5 * 60 * 1000;
      const windowEnd = new Date(Date.now() + CLAIM_WINDOW_MS);
      const now = new Date().toISOString();

      const scheduled = await queries.meetingSession.listScheduledMeetings(
        db,
        ctx.workspaceId,
        windowEnd.toISOString(),
      );

      if (scheduled.length > 0) {
        const ids = scheduled.map((m) => m.id);
        const claimedRows = await queries.meetingSession.claimMeetingSessions(
          db,
          ids,
          ctx.workspaceId,
          now,
        );
        if (claimedRows.length > 0) {
          const scheduledMap = new Map(scheduled.map((m) => [m.id, m]));
          meetings = claimedRows.map((row) => {
            const sched = scheduledMap.get(row.id);
            return {
              id: row.id,
              meeting_url: row.meetingUrl,
              participants: row.participants as string[],
              workspace_id: row.workspaceId,
              agent_id: row.agentId,
              agent_name: sched?.agentName || "",
              title: sched?.title || undefined,
            };
          });
        }
      }
    } catch (e) {
      log.warn("meeting-claim: failed in poll", { err: String(e) });
    }
  }

  // File browse requests — skip D1 if KV negative cache says "no pending"
  let fileRequests: FileRequestItem[] | undefined;
  try {
    await throttled(`expire_fr:${ctx.workspaceId}`, 5, async () => {
      await queries.workspaceFileRequest.expireStale(db, ctx.workspaceId!);
    });
    const kv = (env as Env).CACHE_KV ?? null;
    const frFlag = kv ? await kv.get(cacheKeys.hasPendingFileRequest(ctx.workspaceId!)) : null;
    if (frFlag !== "0") {
      const pending = await queries.workspaceFileRequest.getPendingByWorkspace(db, ctx.workspaceId);
      if (pending.length > 0) {
        fileRequests = pending.map((r) => ({
          id: r.id,
          agent_id: r.agentId,
          request_type: r.requestType as "tree" | "read",
          path: r.path,
        }));
        await queries.workspaceFileRequest.markDispatched(db, pending.map((r) => r.id));
      } else if (kv) {
        kv.put(cacheKeys.hasPendingFileRequest(ctx.workspaceId!), "0", { expirationTtl: 60 }).catch(() => {});
      }
    }
  } catch (e) {
    log.warn("file-requests: poll failed", { err: String(e) });
  }

  return writeJSON({
    tasks,
    ...(pendingUpdate && { pending_update: pendingUpdate }),
    ...(pendingRescan && { pending_rescan: pendingRescan }),
    ...(fileRequests && { file_requests: fileRequests }),
    ...(meetings && { meetings }),
  });
});
