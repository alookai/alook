import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const weekEnd = new Date(todayStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndISO = weekEnd.toISOString();

  const dateStr = todayStart.toISOString().slice(0, 10);

  const [allAgents, allAccess] = await Promise.all([
    cached(cacheKeys.allAgents(ws.workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const visibleAgents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  const visibleAgentIds = visibleAgents.map((a) => a.id);

  const [
    emailStats,
    emailAccounts,
    taskStats,
    recentTasks,
    conversationCounts,
    members,
    invites,
    calendarEvents,
  ] = await Promise.all([
    cached(cacheKeys.overviewEmailStats(ws.workspaceId), 60, () => queries.overview.getEmailStatsByWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.overviewEmailAccounts(ws.workspaceId), 300, () => queries.overview.getEmailAccountsByWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr), 60, () => queries.overview.getTaskStatsByWorkspace(db, ws.workspaceId, todayISO)),
    queries.overview.getRecentTerminalTasks(db, ws.workspaceId, visibleAgentIds, 15),
    queries.overview.getConversationCountsByAgent(db, ws.workspaceId, visibleAgentIds),
    cached(cacheKeys.allMembers(ws.workspaceId), 600, () => queries.member.listMembers(db, ws.workspaceId)),
    queries.workspaceInvite.listActiveInvites(db, ws.workspaceId),
    queries.calendarEvent.listCalendarEvents(db, ws.workspaceId, {
      userId: ctx.userId,
      from: todayISO,
      to: weekEndISO,
    }),
  ]);

  const conversationCountMap: Record<string, number> = {};
  for (const row of conversationCounts) {
    conversationCountMap[row.agentId] = Number(row.cnt);
  }

  return writeJSON({
    email_stats: emailStats,
    email_accounts: emailAccounts.map((a) => ({
      id: a.id,
      agent_id: a.agentId,
      email_address: a.emailAddress,
      status: a.status,
      error_message: a.errorMessage,
      last_synced_at: a.lastSyncedAt,
    })),
    task_stats: taskStats,
    recent_tasks: recentTasks.map((t) => ({
      id: t.id,
      agent_id: t.agentId,
      type: t.type,
      status: t.status,
      prompt: t.prompt,
      created_at: t.createdAt,
      completed_at: t.completedAt,
      error: t.error,
    })),
    conversation_counts: conversationCountMap,
    members: members.map((m) => ({
      id: m.id,
      user_id: m.userId,
      role: m.role,
      name: m.userName,
      email: m.userEmail,
      image: m.userImage,
      created_at: m.createdAt,
    })),
    pending_invites: invites.length,
    calendar_events: calendarEvents.map((e) => ({
      id: e.id,
      agent_id: e.agentId,
      title: e.title,
      description: e.description,
      scheduled_at: e.scheduledAt,
      repeat_interval: e.repeatInterval,
      repeat_stop_at: e.repeatStopAt,
      last_triggered_at: e.lastTriggeredAt,
    })),
  });
});
