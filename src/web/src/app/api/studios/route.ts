import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, CreateStudioRequestSchema, isValidHandle, isOnline, TASK_TYPES } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse, workspaceToResponse, agentLinkToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function generateUniqueHandle(
  db: ReturnType<typeof getDb>,
  baseName: string,
): Promise<string> {
  const base = baseName.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  if (isValidHandle(base)) {
    const existing = await queries.agent.getAgentByHandle(db, base);
    if (!existing) return base;
  }
  for (let i = 0; i < 5; i++) {
    const suffix = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "lowerCase" });
    const candidate = `${base}-${suffix}`.slice(0, 30);
    if (!isValidHandle(candidate)) continue;
    const existing = await queries.agent.getAgentByHandle(db, candidate);
    if (!existing) return candidate;
  }
  return `${base}-${nanoid(6)}`;
}

const LINK_INSTRUCTIONS: Record<string, { toLeader: string; fromLeader: string }> = {
  researcher: {
    fromLeader: "Ask for research, document reading, and context summaries.",
    toLeader: "Send findings back so they can be summarized for the user.",
  },
  engineer: {
    fromLeader: "Ask for code changes, test runs, and implementation checks.",
    toLeader: "Send code changes and test results back.",
  },
  assistant: {
    fromLeader: "Ask for email follow-ups, reminders, and task tracking.",
    toLeader: "Report completed follow-ups and upcoming reminders.",
  },
};

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, valErr] = await parseBody(req, CreateStudioRequestSchema);
  if (valErr) return valErr;

  const leaderMember = body.members.find((m) => m.role === "leader")!;

  const runtimeIds = [...new Set(body.members.map((m) => m.runtime_id))];
  const runtimeCache = new Map<string, { id: string; runtimeMode: string; machineLastSeenAt: string | null }>();
  for (const rid of runtimeIds) {
    const runtime = await queries.runtime.getAgentRuntimeForWorkspace(db, rid, ws.workspaceId);
    if (!runtime) {
      return writeError(`runtime ${rid} not found in workspace`, 404);
    }
    runtimeCache.set(rid, runtime);
  }

  // Update workspace name/slug if a name is provided
  let updatedWorkspace = await queries.workspace.getWorkspace(db, ws.workspaceId, ctx.userId);
  if (!updatedWorkspace) {
    return writeError("workspace not found", 404);
  }

  if (body.name) {
    const existingAgents = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
    const newSlug = slugify(body.name);
    if (existingAgents.length === 0 && newSlug) {
      let finalSlug = newSlug;
      const conflicting = await queries.workspace.getWorkspaceBySlug(db, newSlug);
      if (conflicting && conflicting.id !== ws.workspaceId) {
        let found = false;
        for (let i = 0; i < 5; i++) {
          const suffix = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "lowerCase" });
          const candidate = `${newSlug}-${suffix}`.slice(0, 60);
          const c = await queries.workspace.getWorkspaceBySlug(db, candidate);
          if (!c || c.id === ws.workspaceId) {
            finalSlug = candidate;
            found = true;
            break;
          }
        }
        if (!found) finalSlug = `${newSlug}-${nanoid(6)}`;
      }
      const updated = await queries.workspace.updateWorkspace(db, ws.workspaceId, {
        name: body.name.trim(),
        slug: finalSlug,
      });
      if (updated) updatedWorkspace = updated;
    } else {
      await queries.workspace.updateWorkspace(db, ws.workspaceId, {
        name: body.name.trim(),
      });
      updatedWorkspace = await queries.workspace.getWorkspace(db, ws.workspaceId, ctx.userId);
    }
  }


  // Create agents
  const createdAgents: Array<{ id: string; role: string; name: string; emailHandle: string | null; runtimeId: string | null }> = [];

  for (const member of body.members) {
    const agentName = member.name || `Agent-${nanoid(4)}`;
    const handle = member.email_handle && isValidHandle(member.email_handle)
      ? member.email_handle
      : await generateUniqueHandle(db, agentName);

    const rc = member.runtime_config;
    const sanitizedRc: Record<string, unknown> | null = rc
      ? { ...(typeof rc.model === "string" ? { model: rc.model } : {}) }
      : null;

    const runtime = runtimeCache.get(member.runtime_id);

    const newAgent = await queries.agent.createAgent(db, {
      workspaceId: ws.workspaceId,
      name: agentName,
      description: member.description || "",
      instructions: member.instructions || "",
      runtimeId: member.runtime_id,
      runtimeMode: runtime?.runtimeMode ?? "local",
      runtimeConfig: sanitizedRc,
      visibility: "private",
      maxConcurrentTasks: 6,
      ownerId: ctx.userId,
      emailHandle: handle,
      avatarUrl: member.avatar_url ?? null,
    });

    if (ctx.email) {
      await queries.whitelist.addWhitelist(db, newAgent.id, ws.workspaceId, ctx.email.toLowerCase());
    }

    createdAgents.push({
      id: newAgent.id,
      role: member.role,
      name: agentName,
      emailHandle: newAgent.emailHandle,
      runtimeId: newAgent.runtimeId,
    });
  }

  // Create agent links (leader <-> specialists)
  const leaderAgent = createdAgents.find((a) => a.role === "leader")!;
  const specialists = createdAgents.filter((a) => a.role !== "leader");
  const createdLinks = [];

  for (const specialist of specialists) {
    const instructions = LINK_INSTRUCTIONS[specialist.role] || {
      fromLeader: `Collaborate with ${specialist.name}.`,
      toLeader: `Report results back to the leader.`,
    };

    try {
      const link = await queries.agentLink.create(db, {
        workspaceId: ws.workspaceId,
        sourceAgentId: leaderAgent.id,
        targetAgentId: specialist.id,
        instruction: `${instructions.fromLeader}\n${instructions.toLeader}`,
      });
      createdLinks.push(link);
    } catch {
      // Best-effort — don't fail the whole studio creation
    }
  }

  // Enqueue welcome email for leader only
  const leaderRuntime = runtimeCache.get(body.members.find((m) => m.role === "leader")!.runtime_id);

  if (leaderAgent.emailHandle && ctx.email && leaderRuntime && isOnline(leaderRuntime.machineLastSeenAt)) {
    try {
      const teammatesList = createdAgents
        .filter((a) => a.id !== leaderAgent.id)
        .map((a) => `- ${a.name} (${a.emailHandle}@alook.ai), role: ${a.role}`)
        .join("\n");

      const welcomePrompt = createdAgents.length === 1
        ? `You have just been created by your owner (${ctx.email}). Please send them a welcome email introducing yourself as "${leaderAgent.name}". In the email: 1) Introduce yourself warmly — your name, your email address, and what you can help with. 2) Briefly introduce the Alook platform. 3) Let them know they can chat with you directly or email you anytime. Be warm, professional, and concise.`
        : `You have just been created as the lead of a new AI studio by your owner (${ctx.email}). Your teammates are:\n${teammatesList}\n\nPlease send a welcome email to your owner introducing yourself and all your teammates. Include: 1) Your name and email address. 2) Each teammate's name, email, and what they handle. 3) How the team works together — you coordinate and delegate to specialists. 4) Let them know they can email you directly to assign work. Be warm, professional, and concise.`;

      const conv = await queries.conversation.createConversation(db, {
        workspaceId: ws.workspaceId,
        agentId: leaderAgent.id,
        userId: ctx.userId,
        title: `Welcome: ${ctx.email}`.slice(0, 50),
        type: TASK_TYPES.EMAIL_NOTIFICATION,
      });
      const taskService = new TaskService(db);
      await taskService.enqueueTask(
        leaderAgent.id,
        conv.id,
        ws.workspaceId,
        welcomePrompt,
        TASK_TYPES.EMAIL_NOTIFICATION,
      );
    } catch {
      // Best-effort
    }
  }

  // Fetch final agents for response
  const agents = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
  const studioAgents = agents.filter((a) => createdAgents.some((ca) => ca.id === a.id));
  const finalWorkspace = await queries.workspace.getWorkspace(db, ws.workspaceId, ctx.userId);

  return writeJSON({
    studio: { name: finalWorkspace?.name || body.name || "" },
    workspace: workspaceToResponse(finalWorkspace || updatedWorkspace),
    leader_agent_id: leaderAgent.id,
    agents: studioAgents.map(agentToResponse),
    links: createdLinks.map(agentLinkToResponse),
  }, 201);
});
