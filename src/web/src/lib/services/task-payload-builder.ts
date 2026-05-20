import type { Database, ClaimedTaskRow } from "@alook/shared";
import { queries, TASK_TYPES, toAlookAddress } from "@alook/shared";
import { taskToResponse } from "@/lib/api/responses";
import { cached, cacheKeys } from "@/lib/cache";

export class TaskPayloadBuilder {
  constructor(private db: Database) {}

  async buildFullPayloads(tasks: ClaimedTaskRow[], workspaceId: string) {
    const nonKillTasks = tasks.filter((t) => t.type !== TASK_TYPES.KILL_TASK);
    const agentIds = [...new Set(nonKillTasks.map((t) => t.agentId))];

    const [allAgents, allEmailAccounts, allColleagues] = agentIds.length > 0
      ? await Promise.all([
          cached(cacheKeys.allAgents(workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(this.db, workspaceId)),
          cached(cacheKeys.allEmailAccounts(workspaceId), 600, () => queries.emailAccount.getAllEmailAccountsForWorkspace(this.db, workspaceId)),
          cached(cacheKeys.allColleagues(workspaceId), 600, () => queries.agentLink.getAllColleaguesForWorkspace(this.db, workspaceId)).catch(() => [] as Awaited<ReturnType<typeof queries.agentLink.getAllColleaguesForWorkspace>>),
        ]).then(([agents, emails, colleagues]) => {
          const agentIdSet = new Set(agentIds);
          return [
            agents.filter((a) => agentIdSet.has(a.id)),
            emails.filter((a) => agentIdSet.has(a.agentId)),
            colleagues.filter((c) => agentIdSet.has(c.agentId)),
          ] as const;
        })
      : [[], [], [] as Awaited<ReturnType<typeof queries.agentLink.getAllColleaguesForWorkspace>>];

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

    const memberCache = new Map<string, { globalInstruction: string } | null>();
    const userCache = new Map<string, { name: string; email: string } | null>();
    const convoCache = new Map<string, Awaited<ReturnType<typeof queries.conversation.getConversation>> | null>();

    const results = [];
    for (const task of tasks) {
      if (task.type === TASK_TYPES.KILL_TASK) {
        results.push({ ...taskToResponse(task), agent: null, sender: null });
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
            cacheKeys.member(workspaceId, agent.ownerId),
            600,
            () => queries.member.getMemberByUserAndWorkspace(this.db, agent.ownerId!, workspaceId),
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
            () => queries.user.getUser(this.db, agent.ownerId!),
          );
          userCache.set(agent.ownerId, u ? { name: u.name, email: u.email } : null);
        }
        ownerName = userCache.get(agent.ownerId)?.name ?? null;
      }

      let convo = convoCache.get(task.conversationId) ?? null;
      if (task.conversationId && !convoCache.has(task.conversationId)) {
        convo = await queries.conversation.getConversation(this.db, task.conversationId, workspaceId);
        convoCache.set(task.conversationId, convo);
      }
      const taskChannel = convo?.channel ?? "default";

      let sender: { name: string; email: string; is_owner: boolean } | null = null;
      if (task.type === TASK_TYPES.USER_DM_MESSAGE && convo?.userId) {
        if (!userCache.has(convo.userId)) {
          const u = await cached(
            cacheKeys.user(convo.userId),
            1800,
            () => queries.user.getUser(this.db, convo!.userId!),
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

      results.push({
        ...taskToResponse(task),
        channel: taskChannel,
        sender,
        agent: agent
          ? {
              instructions,
              name: agent.name,
              runtime_config: (agent.runtimeConfig || {}) as Record<string, unknown>,
              email_handle: agent.emailHandle || null,
              email_addresses: emailAddresses,
              user_email: null as string | null,
              user_name: ownerName,
              colleagues,
            }
          : null,
      });
    }

    return results;
  }
}
