import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, RecruitAgentRequestSchema, isValidHandle, isOnline, TASK_TYPES } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse, agentLinkToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { invalidate, cached, cacheKeys } from "@/lib/cache";
import { broadcastToUser } from "@/lib/broadcast";
import { randomConfig, serializeAvatarConfig } from "@/components/avatar";

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

  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return writeError("agentId query param is required", 400);
  }

  const [body, valErr] = await parseBody(req, RecruitAgentRequestSchema);
  if (valErr) return valErr;

  const callingAgent = await queries.agent.getAgent(db, agentId, ws.workspaceId);
  if (!callingAgent) {
    return writeError("calling agent not found in workspace", 404);
  }

  const runtime = callingAgent.runtimeId
    ? await queries.runtime.getAgentRuntimeForWorkspace(db, callingAgent.runtimeId, ws.workspaceId)
    : null;
  if (!runtime) {
    return writeError("calling agent has no runtime", 400);
  }

  const agentName = body.name?.trim() || uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" });

  const allHandles = await cached(cacheKeys.allHandles(ws.workspaceId), 120, () =>
    queries.agent.getAllHandlesForWorkspace(db, ws.workspaceId),
  );
  const handleSet = new Set(allHandles.map((h) => h.emailHandle).filter(Boolean) as string[]);
  const handle = generateUniqueHandleFromSet(handleSet, agentName);

  const sanitizedRc: Record<string, unknown> | null = body.model ? { model: body.model } : null;

  const newAgent = await queries.agent.createAgent(db, {
    workspaceId: ws.workspaceId,
    name: agentName,
    description: body.description || "",
    instructions: body.instructions,
    runtimeId: callingAgent.runtimeId,
    runtimeMode: runtime.runtimeMode,
    runtimeConfig: sanitizedRc,
    visibility: "private",
    maxConcurrentTasks: 6,
    ownerId: ctx.userId,
    emailHandle: handle,
    avatarUrl: serializeAvatarConfig(randomConfig()),
  });

  const link = await queries.agentLink.create(db, {
    workspaceId: ws.workspaceId,
    sourceAgentId: agentId,
    targetAgentId: newAgent.id,
    instruction: body.relationship,
  });

  if (callingAgent.emailHandle) {
    const callerEmail = `${callingAgent.emailHandle}@alook.ai`;
    await queries.whitelist.addWhitelist(db, newAgent.id, ws.workspaceId, callerEmail);
  }
  if (ctx.email) {
    await queries.whitelist.addWhitelist(db, newAgent.id, ws.workspaceId, ctx.email.toLowerCase());
  }

  await Promise.all([
    invalidate(cacheKeys.allAgents(ws.workspaceId)),
    invalidate(cacheKeys.allHandles(ws.workspaceId)),
    invalidate(cacheKeys.allAgentAccess(ws.workspaceId)),
    invalidate(cacheKeys.allColleagues(ws.workspaceId)),
    invalidate(cacheKeys.agentLinks(ws.workspaceId)),
  ]);

  broadcastToUser(ctx.userId, {
    type: "agent.created",
    agentId: newAgent.id,
    workspaceId: ws.workspaceId,
    parentAgentId: agentId,
  }).catch(() => {});

  if (isOnline(runtime.machineLastSeenAt)) {
    try {
      const callerName = callingAgent.name;
      const callerEmail = callingAgent.emailHandle ? `${callingAgent.emailHandle}@alook.ai` : "your recruiter";
      const welcomePrompt = `You have just been recruited by your colleague ${callerName} (${callerEmail}). Your instructions are already set. Please send them a short email introducing yourself — your name, your email address, and confirming you're ready to work. Be warm and concise.`;

      const conv = await queries.conversation.createConversation(db, {
        workspaceId: ws.workspaceId,
        agentId: newAgent.id,
        userId: ctx.userId,
        title: `Welcome from ${callerName}`.slice(0, 50),
        type: TASK_TYPES.EMAIL_NOTIFICATION,
      });
      const taskService = new TaskService(db);
      await taskService.enqueueTask(
        newAgent.id,
        conv.id,
        ws.workspaceId,
        welcomePrompt,
        TASK_TYPES.EMAIL_NOTIFICATION,
      );
    } catch {
      // Best-effort
    }
  }

  return writeJSON({
    agent: { ...agentToResponse(newAgent), email: `${handle}@alook.ai` },
    link: agentLinkToResponse(link),
  }, 201);
});
