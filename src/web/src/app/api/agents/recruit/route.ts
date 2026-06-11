import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, RecruitAgentRequestSchema, isValidHandle, isOnline, buildMimeMessage, extractThreadId, buildEmailMapKey, DEV_WEB_URL, toAlookAddress } from "@alook/shared";
import { nanoid } from "nanoid";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse, agentLinkToResponse } from "@/lib/api/responses";
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

  const callingAgent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!callingAgent) {
    return writeError("not found", 404);
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
    const callerEmail = toAlookAddress(callingAgent.emailHandle);
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

  if (isOnline(runtime.machineLastSeenAt) && callingAgent.emailHandle) {
    try {
      const cfEnv = env as Env;
      const fromAddress = toAlookAddress(callingAgent.emailHandle);
      const toAddress = toAlookAddress(handle);
      const subject = "Welcome aboard";
      const htmlBody = `<p>Hi, I just recruited you. Your instructions are already set. Please reply confirming you're ready to work — tell me your name and email address.</p>`;
      const messageId = `<${nanoid()}@alook.ai>`;
      const traceId = "tr_" + nanoid();

      const rawMime = buildMimeMessage({
        from: fromAddress,
        to: toAddress,
        subject,
        messageId,
        body: htmlBody,
        bodyType: "text/html",
      });

      const r2Key = `emails/${nanoid()}/raw`;
      await cfEnv.EMAIL_BUCKET.put(r2Key, rawMime, {
        httpMetadata: { contentType: "message/rfc822" },
      });

      // Notify agent B (local delivery)
      const notifyPayload = JSON.stringify({
        agentId: newAgent.id,
        workspaceId: ws.workspaceId,
        r2Key,
        from: fromAddress,
        to: toAddress,
        subject,
        isWhitelisted: true,
        forwarded: false,
        messageId,
        inReplyTo: "",
        references: "",
        isInternal: true,
        traceId,
      });
      const notifyInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: notifyPayload };
      try {
        await cfEnv.WORKER_SELF_REFERENCE!.fetch("http://internal/api/email/notify", notifyInit);
      } catch {
        await fetch(`${DEV_WEB_URL}/api/email/notify`, notifyInit);
      }

      // Record outbound email on agent A
      await queries.email.createEmail(db, {
        agentId,
        workspaceId: ws.workspaceId,
        fromEmail: fromAddress,
        toEmail: toAddress,
        subject,
        r2Key,
        isWhitelisted: false,
        forwarded: false,
        messageId,
        inReplyTo: "",
        references: "",
        htmlBody,
        direction: "outbound",
        status: "sent",
      });

      // Map thread to recruiter's conversation so replies route back
      const conversationId = body.context_key || null;
      if (conversationId) {
        const threadId = extractThreadId("", "", messageId);
        if (threadId) {
          await queries.conversationMap.createMapping(db, {
            key: buildEmailMapKey(agentId, threadId),
            workspaceId: ws.workspaceId,
            conversationId,
          });
        }
      }
    } catch {
      // Best-effort
    }
  }

  return writeJSON({
    agent: { ...agentToResponse(newAgent), email: toAlookAddress(handle) },
    link: agentLinkToResponse(link),
  }, 201);
});
