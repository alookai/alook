import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, PollRequestSchema, semverGte, toAlookAddress, type FileRequestItem, type PollMeetingItem } from "@alook/shared";
import { getDb, withD1Retry } from "@/lib/db"
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
  const { cached, cachedBatch, cacheKeys } = await import("@/lib/cache");

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

  // 2. Liveness: write heartbeat to KV (fast) + throttle D1 upsert to every 60s
  // Non-critical — D1 transient failures should not block task polling
  const kv = (env as Env).CACHE_KV ?? null;
  if (kv) {
    kv.put(
      cacheKeys.heartbeat(ctx.workspaceId, body.daemon_id),
      new Date().toISOString(),
      { expirationTtl: 15 },
    ).catch(() => {});
  }
  try {
    await cached(
      `hb_d1:${ctx.workspaceId}:${body.daemon_id}`,
      60,
      async () => {
        await queries.machine.upsertMachine(db, {
          daemonId: body.daemon_id,
          workspaceId: ctx.workspaceId!,
          deviceInfo: body.daemon_id,
        });
        return "1";
      },
    );
  } catch (e) {
    log.warn("machine upsert failed", { daemonId: body.daemon_id, err: String(e) });
  }

  broadcastToUser(ctx.userId, {
    type: "runtime.status",
    daemonId: body.daemon_id,
    workspaceId: ctx.workspaceId,
    status: "online",
  }).catch(() => {});

  // 3. Housekeeping: sweep stale state — non-critical
  try {
    await sweepStaleState(db, ctx.workspaceId);
  } catch (e) {
    log.warn("sweep failed", { workspaceId: ctx.workspaceId, err: String(e) });
  }

  // 3b. Promote due calendar events — throttled to once per 30s per workspace
  try {
    let calRun = false;
    await cached(`cal:${ctx.workspaceId}`, 30, async () => {
      calRun = true;
      return "1";
    }).catch(() => { calRun = true; });
    if (calRun) {
      const enqueued = await promoteDueCalendarEventsForWorkspace(
        db,
        ctx.workspaceId,
      );
      if (enqueued > 0) {
        log.info("calendar: enqueued", { workspaceId: ctx.workspaceId, enqueued });
      }
    }
  } catch (err) {
    log.warn("calendar: promote failed", {
      workspaceId: ctx.workspaceId,
      err: String(err),
    });
  }

  // 4. Task claiming
  const taskService = new TaskService(db);
  const claimed = await withD1Retry(() => taskService.claimTasksForRuntimes(
    runtimeIds,
    body.max_tasks,
    ctx.workspaceId!,
  ));

  // Batch-fetch shared data before the task loop to avoid N+1 queries
  // Uses KV cache for stable data (agents, emails, colleagues)
  const nonKillTasks = claimed.filter((t) => t.type !== "kill_task");
  const agentIds = [...new Set(nonKillTasks.map((t) => t.agentId))];

  const [allAgents, allEmailAccounts, allColleagues] = agentIds.length > 0
    ? await Promise.all([
        cachedBatch(
          agentIds.map((id) => cacheKeys.agent(ctx.workspaceId!, id)),
          300,
          async (missingKeys) => {
            const missingIds = missingKeys.map((k) => k.split(":").pop()!);
            const agents = await withD1Retry(() => queries.agent.getAgentsByIds(db, missingIds, ctx.workspaceId!));
            const result = new Map<string, (typeof agents)[number]>();
            for (const a of agents) {
              result.set(cacheKeys.agent(ctx.workspaceId!, a.id), a);
            }
            return result;
          },
        ).then((m) => [...m.values()]),
        Promise.all(
          agentIds.map((id) =>
            cached(cacheKeys.emailAccountsByAgent(ctx.workspaceId!, id), 900, () =>
              queries.emailAccount.getEmailAccountsByAgents(db, [id], ctx.workspaceId!),
            ),
          ),
        ).then((arrays) => arrays.flat()),
        Promise.all(
          agentIds.map((id) =>
            cached(cacheKeys.colleaguesByAgent(ctx.workspaceId!, id), 300, () =>
              queries.agentLink.getColleaguesForAgents(db, [id], ctx.workspaceId!),
            ).catch(() => [] as Awaited<ReturnType<typeof queries.agentLink.getColleaguesForAgents>>),
          ),
        ).then((arrays) => arrays.flat()),
      ])
    : [[], [], [] as Awaited<ReturnType<typeof queries.agentLink.getColleaguesForAgents>>];

  const agentMap = new Map(allAgents.map((a) => [a.id, a]));
  const emailAccountsByAgent = new Map<string, string[]>();
  for (const acc of allEmailAccounts) {
    const list = emailAccountsByAgent.get(acc.agentId) ?? [];
    list.push(acc.emailAddress);
    emailAccountsByAgent.set(acc.agentId, list);
  }
  const colleaguesByAgent = new Map<string, typeof allColleagues>();
  for (const c of allColleagues) {
    const list = colleaguesByAgent.get(c.agentId) ?? [];
    list.push(c);
    colleaguesByAgent.set(c.agentId, list);
  }

  const tasks = [];
  const memberCache = new Map<string, { globalInstruction: string } | null>();
  const userCache = new Map<string, { name: string; email: string } | null>();
  const convoCache = new Map<string, Awaited<ReturnType<typeof queries.conversation.getConversation>> | null>();
  for (const task of claimed) {
    if (task.type === "kill_task") {
      tasks.push({ ...taskToResponse(task), agent: null, sender: null });
      continue;
    }

    const agent = agentMap.get(task.agentId) ?? null;
    const emailAddresses: string[] = [];
    if (agent) {
      if (agent.emailHandle) emailAddresses.push(`${agent.emailHandle}@alook.ai`);
      const customAccounts = emailAccountsByAgent.get(agent.id) ?? [];
      emailAddresses.push(...customAccounts);
    }

    let instructions = agent?.instructions ?? "";
    if (agent?.ownerId) {
      if (!memberCache.has(agent.ownerId)) {
        const m = await cached(
          cacheKeys.member(task.workspaceId, agent.ownerId),
          600,
          () => queries.member.getMemberByUserAndWorkspace(db, agent.ownerId!, task.workspaceId),
        );
        memberCache.set(agent.ownerId, m ? { globalInstruction: m.globalInstruction } : null);
      }
      const cachedMember = memberCache.get(agent.ownerId);
      if (cachedMember?.globalInstruction) {
        instructions = [cachedMember.globalInstruction, instructions].filter(Boolean).join("\n\n");
      }
    }

    let ownerName: string | null = null;
    if (agent?.ownerId) {
      if (!userCache.has(agent.ownerId)) {
        const u = await cached(
          cacheKeys.user(agent.ownerId),
          1800,
          () => queries.user.getUser(db, agent.ownerId!),
        );
        userCache.set(agent.ownerId, u ? { name: u.name, email: u.email } : null);
      }
      ownerName = userCache.get(agent.ownerId)?.name ?? null;
    }

    let convo = convoCache.get(task.conversationId) ?? null;
    if (task.conversationId && !convoCache.has(task.conversationId)) {
      convo = await queries.conversation.getConversation(db, task.conversationId, task.workspaceId);
      convoCache.set(task.conversationId, convo);
    }
    const taskChannel = convo?.channel ?? "default";

    let sender: { name: string; email: string; is_owner: boolean } | null = null;
    if (task.type === "user_dm_message" && convo?.userId) {
      if (!userCache.has(convo.userId)) {
        const u = await cached(
          cacheKeys.user(convo.userId),
          1800,
          () => queries.user.getUser(db, convo!.userId!),
        );
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

    const rawColleagues = colleaguesByAgent.get(task.agentId) ?? [];
    const colleagues = rawColleagues.map((c) => ({
      name: c.name,
      email: c.emailHandle ? toAlookAddress(c.emailHandle) : "",
      description: c.description,
      instruction: c.instruction,
    }));

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

  // 5. Pending update & rescan check + meeting claim — throttled to once per 30s
  let pendingUpdate: { version: string } | undefined;
  let pendingRescan: boolean | undefined;
  let meetings: PollMeetingItem[] | undefined;
  const miscKey = `misc:${ctx.workspaceId}:${body.daemon_id}`;
  let runMisc = false;
  try {
    await cached(miscKey, 30, async () => { runMisc = true; return "1"; });
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

  // File browse requests — expireStale throttled to 5s, but check pending every poll
  let fileRequests: FileRequestItem[] | undefined;
  try {
    let expireRun = false;
    await cached(`expire_fr:${ctx.workspaceId}`, 5, async () => { expireRun = true; return "1"; }).catch(() => { expireRun = true; });
    if (expireRun) {
      await queries.workspaceFileRequest.expireStale(db, ctx.workspaceId);
    }
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

  return writeJSON({
    tasks,
    ...(pendingUpdate && { pending_update: pendingUpdate }),
    ...(pendingRescan && { pending_rescan: pendingRescan }),
    ...(fileRequests && { file_requests: fileRequests }),
    ...(meetings && { meetings }),
  });
});
