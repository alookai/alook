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

type LinkInstruction = { fromLeader: string; toLeader: string };

const SCENARIO_LINK_INSTRUCTIONS: Record<string, Record<string, LinkInstruction>> = {
  "software-dev": {
    researcher: {
      fromLeader: "Delegate technical research: what to investigate (API, library, architecture pattern), what decision it informs, and what format/depth you need back. Include relevant file paths or code pointers.",
      toLeader: "Report with: Status, technical summary, evidence (file paths, doc URLs, code snippets), recommendation for implementation, and confidence level. Flag anything you couldn't verify from source.",
    },
    engineer: {
      fromLeader: "Delegate coding tasks with: clear requirement, relevant file paths, existing patterns to follow, expected behavior, and test expectations. Include context from researcher findings if relevant.",
      toLeader: "Report with: Status, files changed with descriptions, test results (pass/fail), self-review findings, and concerns about correctness or edge cases.",
    },
  },
  "content-research": {
    researcher: {
      fromLeader: "Delegate content research: topic/claim to investigate, target content format (article, report, social), depth needed (quick check vs. deep dive), and any specific sources to check.",
      toLeader: "Report with: Status, key facts for the writer, organized source list (URL, date, reliability), verification gaps, angle suggestion, and per-claim confidence levels.",
    },
    assistant: {
      fromLeader: "Delegate content operations: what content to format/publish, which platform, deadline, and any style/formatting requirements.",
      toLeader: "Report with: Status, what was done (formatted, published, submitted), next step (awaiting review, scheduled for X), and any blockers (platform issues, access problems).",
    },
  },
  productivity: {
    assistant: {
      fromLeader: "Delegate operational tasks: what action, who's the target, what's the deadline, and tone guidance for external communications.",
      toLeader: "Report with: Status, action taken, next step (waiting for reply, follow-up on X date), and escalation flags (no response, bounced email, conflicting info).",
    },
  },
  "full-team": {
    researcher: {
      fromLeader: "Delegate research tasks with: clear question, decision context, scope boundary, and expected output format.",
      toLeader: "Report with: Status, summary, evidence with sources, recommendation, and confidence level. Flag low-confidence conclusions.",
    },
    engineer: {
      fromLeader: "Delegate coding tasks with: clear requirement, relevant context (file paths, patterns), and expected behavior.",
      toLeader: "Report with: Status, files changed, tests run + results, self-review findings, and concerns about correctness.",
    },
    assistant: {
      fromLeader: "Delegate operational tasks: action needed, target person/system, deadline, and tone guidance.",
      toLeader: "Report with: Status, action taken, next step, and escalation flags.",
    },
  },
};

const DEFAULT_LINK_INSTRUCTIONS: Record<string, LinkInstruction> = {
  researcher: {
    fromLeader: "Delegate research tasks with: clear question, decision context, scope boundary, and expected output format.",
    toLeader: "Report findings with: Status (DONE/BLOCKED/NEEDS_CONTEXT), summary, evidence with sources, recommendation, and confidence level.",
  },
  engineer: {
    fromLeader: "Delegate coding tasks with: clear requirement, relevant context, and expected behavior.",
    toLeader: "Report results with: Status (DONE/BLOCKED/NEEDS_CONTEXT), files changed, tests run + results, self-review findings, and concerns.",
  },
  assistant: {
    fromLeader: "Delegate operational tasks with: action needed, target person/system, deadline, and tone guidance.",
    toLeader: "Report results with: Status (DONE/BLOCKED/NEEDS_CONTEXT), action taken, next step, and escalation flags.",
  },
};

function getLinkInstructions(scenario: string | undefined, role: string): LinkInstruction {
  if (scenario && SCENARIO_LINK_INSTRUCTIONS[scenario]?.[role]) {
    return SCENARIO_LINK_INSTRUCTIONS[scenario][role];
  }
  return DEFAULT_LINK_INSTRUCTIONS[role] || {
    fromLeader: `Collaborate with this team member.`,
    toLeader: `Report results back to the leader.`,
  };
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, valErr] = await parseBody(req, CreateStudioRequestSchema);
  if (valErr) return valErr;

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
    const instructions = getLinkInstructions(body.scenario, specialist.role);

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
