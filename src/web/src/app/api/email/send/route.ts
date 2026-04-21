import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries, DEV_EMAIL_WORKER_URL, SendEmailRequestSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const cfEnv = env as Env;
  const db = createDb(cfEnv.DB);

  const [body, valErr] = await parseBody(req, SendEmailRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, ws.workspaceId);
  if (!agent) return writeError("agent not found in workspace", 404);

  const customAccountId = body.customAccountId;
  let fromAddress: string;

  if (customAccountId) {
    const account = await queries.emailAccount.getEmailAccount(db, customAccountId, ws.workspaceId);
    if (!account || account.agentId !== body.agentId) {
      return writeError("custom email account not found", 404);
    }
    fromAddress = account.emailAddress;
  } else {
    if (!agent.emailHandle) {
      return writeError("agent has no email handle configured", 400);
    }
    fromAddress = `${agent.emailHandle}@alook.ai`;
  }

  const attachments = body.attachments ?? [];

  // Delegate sending + R2 archival to the email worker
  const emailPayload = JSON.stringify({
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    to: body.to,
    subject: body.subject,
    htmlBody: body.htmlBody || "",
    inReplyTo: body.inReplyTo || "",
    references: body.references || "",
    customAccountId: customAccountId || undefined,
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

  const emailResult = await emailRes.json() as { ok: boolean; r2Key: string; messageId?: string };

  // Create DB record
  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    fromEmail: fromAddress,
    toEmail: body.to,
    subject: body.subject,
    r2Key: emailResult.r2Key,
    isWhitelisted: false,
    forwarded: false,
    messageId: emailResult.messageId ?? "",
    inReplyTo: body.inReplyTo ?? "",
    references: body.references ?? "",
    htmlBody: body.htmlBody || "",
    attachments: JSON.stringify(attachments),
  });

  return writeJSON(emailToResponse(email));
});
