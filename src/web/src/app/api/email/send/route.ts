import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries, DEV_EMAIL_WORKER_URL } from "@alook/shared";
import type { EmailAttachment } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const cfEnv = env as Env;
  const db = createDb(cfEnv.DB);

  let body: {
    agentId: string;
    to: string;
    subject: string;
    htmlBody: string;
    attachments?: EmailAttachment[];
  };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  if (!body.agentId || !body.to || !body.subject) {
    return writeError("agentId, to, and subject are required", 400);
  }

  const agent = await queries.agent.getAgent(db, body.agentId, ws.workspaceId);
  if (!agent) return writeError("agent not found in workspace", 404);

  if (!agent.emailHandle) {
    return writeError("agent has no email handle configured", 400);
  }

  const attachments = body.attachments ?? [];

  // Delegate sending + R2 archival to the email worker
  const emailPayload = JSON.stringify({
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    to: body.to,
    subject: body.subject,
    htmlBody: body.htmlBody || "",
    attachmentKeys: attachments.length > 0
      ? attachments.map((a) => ({ key: a.key, filename: a.filename, contentType: a.contentType }))
      : undefined,
  });

  let emailRes: Response;
  try {
    emailRes = await cfEnv.EMAIL_WORKER.fetch("http://internal/send/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: emailPayload,
    });
  } catch {
    // Service binding not connected — fall back to direct URL (local dev)
    emailRes = await fetch(`${DEV_EMAIL_WORKER_URL}/send/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: emailPayload,
    });
  }

  if (!emailRes.ok) {
    const errBody = await emailRes.text();
    return writeError(`email worker error: ${errBody}`, emailRes.status);
  }

  const emailResult = await emailRes.json() as { ok: boolean; r2Key: string };

  // Create DB record
  const fromAddress = `${agent.emailHandle}@alook.ai`;
  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    fromEmail: fromAddress,
    toEmail: body.to,
    subject: body.subject,
    r2Key: emailResult.r2Key,
    isWhitelisted: false,
    forwarded: false,
    htmlBody: body.htmlBody || "",
    attachments: JSON.stringify(attachments),
  });

  return writeJSON(emailToResponse(email));
});
