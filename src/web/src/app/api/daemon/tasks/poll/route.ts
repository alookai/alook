import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, PollRequestSchema, semverGte, toAlookAddress, type FileRequestItem, type PollMeetingItem } from "@alook/shared";
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
  // Per-request caches: avoid duplicate DB reads when multiple tasks share the same owner/user
  const memberCache = new Map<string, { globalInstruction: string } | null>();
  const userCache = new Map<string, { name: string; email: string } | null>();
  const convoCache = new Map<string, Awaited<ReturnType<typeof queries.conversation.getConversation>> | null>();
  for (const task of claimed) {
    if (task.type === "kill_task") {
      tasks.push({ ...taskToResponse(task), agent: null, sender: null });
      continue;
    }

    const agent = await queries.agent.getAgent(db, task.agentId, task.workspaceId);
    const emailAddresses: string[] = [];
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

    // Resolve owner name
    let ownerName: string | null = null;
    if (agent?.ownerId) {
      if (!userCache.has(agent.ownerId)) {
        const u = await queries.user.getUser(db, agent.ownerId);
        userCache.set(agent.ownerId, u ? { name: u.name, email: u.email } : null);
      }
      ownerName = userCache.get(agent.ownerId)?.name ?? null;
    }

    // Fetch conversation for channel (all task types) and sender (DM only)
    let convo = convoCache.get(task.conversationId) ?? null;
    if (task.conversationId && !convoCache.has(task.conversationId)) {
      convo = await queries.conversation.getConversation(db, task.conversationId, task.workspaceId);
      convoCache.set(task.conversationId, convo);
    }
    const taskChannel = convo?.channel ?? "default";

    let sender: { name: string; email: string; is_owner: boolean } | null = null;
    if (task.type === "user_dm_message" && convo?.userId) {
      if (!userCache.has(convo.userId)) {
        const u = await queries.user.getUser(db, convo.userId);
        userCache.set(convo.userId, u ? { name: u.name, email: u.email } : null);
      }
      const cachedUser = userCache.get(convo.userId);
      if (cachedUser) {
        sender = {
          name: cachedUser.name,
          email: cachedUser.email,
          is_owner: convo.userId === agent?.ownerId,
        };
      }
    }

    // Resolve colleagues for agent
    let colleagues: { name: string; email: string; description: string; instruction: string }[] = [];
    if (agent) {
      try {
        const raw = await queries.agentLink.getColleaguesForAgent(db, agent.id, task.workspaceId);
        colleagues = raw.map((c) => ({
          name: c.name,
          email: c.emailHandle ? toAlookAddress(c.emailHandle) : "",
          description: c.description,
          instruction: c.instruction,
        }));
      } catch {}
    }

    tasks.push({
      ...taskToResponse(task),
      channel: taskChannel,
      sender,
      agent: agent
        ? {
            instructions,
            name: agent.name,
            runtime_config: agent.runtimeConfig || {},
            email_handle: agent.emailHandle || null,
            email_addresses: emailAddresses,
            user_email: ctx.email || null,
            user_name: ownerName,
            colleagues,
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

  // 6. Pending rescan check
  let pendingRescan: boolean | undefined;
  if (machineRow?.pendingRescan) {
    pendingRescan = true;
    await queries.machine.clearPendingRescan(db, body.daemon_id, ctx.workspaceId);
  }

  // 7. Pending file browse requests + cleanup
  let fileRequests: FileRequestItem[] | undefined;
  try {
    await queries.workspaceFileRequest.expireStale(db, ctx.workspaceId);
    const pending = await queries.workspaceFileRequest.getPendingByWorkspace(db, ctx.workspaceId);
    if (pending.length > 0) {
      fileRequests = pending.map((r) => ({
        id: r.id,
        agent_id: r.agentId,
        request_type: r.requestType as "tree" | "read",
        path: r.path,
      }));
      await queries.workspaceFileRequest.markDispatched(db, pending.map((r) => r.id));
    }
  } catch (e) {
    log.warn("file-requests: poll failed", { err: String(e) });
  }

  // 8. Meeting claim — piggyback on poll to avoid a separate HTTP request
  let meetings: PollMeetingItem[] | undefined;
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
      const claimed: PollMeetingItem[] = [];
      for (const meeting of scheduled) {
        const updated = await queries.meetingSession.claimMeetingSession(
          db,
          meeting.id,
          ctx.workspaceId,
          now,
        );
        if (updated) {
          claimed.push({
            id: updated.id,
            meeting_url: updated.meetingUrl,
            participants: updated.participants as string[],
            workspace_id: updated.workspaceId,
            agent_name: meeting.agentName || "",
          });
        }
      }
      if (claimed.length > 0) meetings = claimed;
    }
  } catch (e) {
    log.warn("meeting-claim: failed in poll", { err: String(e) });
  }

  return writeJSON({
    tasks,
    ...(pendingUpdate && { pending_update: pendingUpdate }),
    ...(pendingRescan && { pending_rescan: pendingRescan }),
    ...(fileRequests && { file_requests: fileRequests }),
    ...(meetings && { meetings }),
  });
});
