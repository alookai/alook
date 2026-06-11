import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, CreateStudioRequestSchema, isValidHandle, isOnline, TASK_TYPES, toAlookAddress } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse, workspaceToResponse, agentLinkToResponse } from "@/lib/api/responses";
import { randomConfig, serializeAvatarConfig } from "@/components/avatar";
import { TaskService } from "@/lib/services/task";
import { invalidate, cached, cacheKeys } from "@/lib/cache";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function generateUniqueHandleFromSet(
  handleSet: Set<string>,
  baseName: string,
): string {
  const base = baseName.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  if (isValidHandle(base) && !handleSet.has(base)) {
    handleSet.add(base);
    return base;
  }
  for (let i = 0; i < 5; i++) {
    const suffix = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "lowerCase" });
    const candidate = `${base}-${suffix}`.slice(0, 30);
    if (!isValidHandle(candidate)) continue;
    if (!handleSet.has(candidate)) {
      handleSet.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base}-${nanoid(6)}`;
  handleSet.add(fallback);
  return fallback;
}


export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, valErr] = await parseBody(req, CreateStudioRequestSchema);
  if (valErr) return valErr;

  const runtimeIds = [...new Set(body.members.map((m) => m.runtime_id))];
  const runtimes = await queries.runtime.getAgentRuntimesForWorkspace(db, runtimeIds, ws.workspaceId);
  const runtimeCache = new Map(runtimes.map((r) => [r.id, r]));
  for (const rid of runtimeIds) {
    if (!runtimeCache.has(rid)) {
      return writeError(`runtime ${rid} not found in workspace`, 404);
    }
  }

  // Update workspace name/slug if a name is provided
  let updatedWorkspace = await queries.workspace.getWorkspace(db, ws.workspaceId, ctx.userId);
  if (!updatedWorkspace) {
    return writeError("workspace not found", 404);
  }

  if (body.name && ws.memberRole === "owner") {
    const existingAgents = await queries.agent.listAgents(db, ws.workspaceId);
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

  const allHandles = await cached(cacheKeys.allHandles(ws.workspaceId), 120, () => queries.agent.getAllHandlesForWorkspace(db, ws.workspaceId));
  const handleSet = new Set(allHandles.map((h) => h.emailHandle).filter(Boolean) as string[]);

  const usedNames = new Set<string>();
  for (const member of body.members) {
    let agentName = member.name;
    if (!agentName) {
      do {
        agentName = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" });
      } while (usedNames.has(agentName));
    }
    usedNames.add(agentName);
    const handle = member.email_handle && isValidHandle(member.email_handle) && !handleSet.has(member.email_handle)
      ? (handleSet.add(member.email_handle), member.email_handle)
      : generateUniqueHandleFromSet(handleSet, agentName);

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
      avatarUrl: member.avatar_url || serializeAvatarConfig(randomConfig()),
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
    const specIndex = createdAgents.indexOf(specialist);
    const memberPayload = body.members[specIndex];
    if (!memberPayload?.relationship) continue;

    try {
      const link = await queries.agentLink.create(db, {
        workspaceId: ws.workspaceId,
        sourceAgentId: leaderAgent.id,
        targetAgentId: specialist.id,
        instruction: memberPayload.relationship,
      });
      createdLinks.push(link);
    } catch {
      // Best-effort — don't fail the whole studio creation
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  await Promise.all([
    invalidate(cacheKeys.allAgents(ws.workspaceId)),
    invalidate(cacheKeys.allHandles(ws.workspaceId)),
    invalidate(cacheKeys.allColleagues(ws.workspaceId)),
    invalidate(cacheKeys.allAgentAccess(ws.workspaceId)),
    invalidate(cacheKeys.allMembers(ws.workspaceId)),
    invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)),
    invalidate(cacheKeys.agentLinks(ws.workspaceId)),
  ]);

  // Pin leader agent by default
  try {
    await queries.agentPin.pinAgent(db, {
      agentId: leaderAgent.id,
      workspaceId: ws.workspaceId,
      userId: ctx.userId,
    });
    invalidate(cacheKeys.pins(ws.workspaceId, ctx.userId)).catch(() => {});
  } catch {
    // Best-effort
  }

  // Enqueue welcome email for leader only
  const leaderRuntime = runtimeCache.get(body.members.find((m) => m.role === "leader")!.runtime_id);

  if (leaderAgent.emailHandle && ctx.email && leaderRuntime && isOnline(leaderRuntime.machineLastSeenAt)) {
    try {
      const teammatesList = createdAgents
        .filter((a) => a.id !== leaderAgent.id)
        .map((a) => `- ${a.name} (${a.emailHandle ? toAlookAddress(a.emailHandle) : a.name}), role: ${a.role}`)
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

  // Enqueue welcome chat for leader (DM conversation)
  if (leaderAgent && leaderRuntime && isOnline(leaderRuntime.machineLastSeenAt)) {
    try {
      const teammatesList = createdAgents
        .filter((a) => a.id !== leaderAgent.id)
        .map((a) => `- ${a.name} (${a.emailHandle ? toAlookAddress(a.emailHandle) : a.name}), role: ${a.role}`)
        .join("\n");

      const welcomeChatPrompt = createdAgents.length === 1
        ? `You have just been created by your owner (${ctx.email}). Please introduce yourself as "${leaderAgent.name}" in this chat. 1) Introduce yourself warmly — your name and what you can help with. 2) Briefly introduce the Alook platform. 3) Let them know they can chat with you directly or email you anytime. Be warm, professional, and concise. Reply in the same language as your owner's name or email suggests.`
        : `You have just been created as the lead of a new AI studio by your owner (${ctx.email}). Your teammates are:\n${teammatesList}\n\nPlease introduce yourself and all your teammates in this chat. Include: 1) Your name. 2) Each teammate's name and what they handle. 3) How the team works together — you coordinate and delegate to specialists. 4) Let them know they can chat with you directly to assign work. Be warm, professional, and concise. Reply in the same language as your owner's name or email suggests.`;

      const dmConv = await queries.conversation.createConversation(db, {
        workspaceId: ws.workspaceId,
        agentId: leaderAgent.id,
        userId: ctx.userId,
        title: `Welcome`,
        type: TASK_TYPES.USER_DM_MESSAGE,
      });
      const taskService2 = new TaskService(db);
      await taskService2.enqueueTask(
        leaderAgent.id,
        dmConv.id,
        ws.workspaceId,
        welcomeChatPrompt,
        TASK_TYPES.USER_DM_MESSAGE,
      );
    } catch {
      // Best-effort
    }
  }

  // Fetch final agents for response
  const agents = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
  const createdIdSet = new Set(createdAgents.map((ca) => ca.id));
  const studioAgents = agents.filter((a) => createdIdSet.has(a.id));
  const finalWorkspace = await queries.workspace.getWorkspace(db, ws.workspaceId, ctx.userId);

  return writeJSON({
    studio: { name: finalWorkspace?.name || body.name || "" },
    workspace: workspaceToResponse(finalWorkspace || updatedWorkspace),
    leader_agent_id: leaderAgent.id,
    agents: studioAgents.map(agentToResponse),
    links: createdLinks.map(agentLinkToResponse),
  }, 201);
});
