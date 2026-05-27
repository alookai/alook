import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CreateEmailDraftRequestSchema, EmailMailbox, queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";
import { resolveEmailSender } from "../sender";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, valErr] = await parseBody(req, CreateEmailDraftRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found in workspace", 404);

  const sender = await resolveEmailSender(db, {
    agent,
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    from: body.from,
    customAccountId: body.customAccountId,
  });
  if ("error" in sender) return writeError(sender.error ?? "invalid sender", sender.status ?? 400);

  let inReplyTo = body.inReplyTo ?? "";
  let references = body.references ?? "";
  if (body.inReplyToEmailId) {
    const parent = await queries.email.getEmailById(db, body.inReplyToEmailId, ws.workspaceId);
    if (!parent) return writeError("parent email not found", 404);
    inReplyTo = parent.messageId || inReplyTo;
    references = [parent.references, parent.messageId].filter(Boolean).join(" ").trim();
  }

  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    fromEmail: sender.fromAddress,
    toEmail: body.to,
    subject: body.subject,
    r2Key: "",
    isWhitelisted: false,
    forwarded: false,
    messageId: "",
    inReplyTo,
    references,
    htmlBody: body.htmlBody,
    attachments: JSON.stringify(body.attachments ?? []),
    direction: "outbound",
    status: "draft",
    mailbox: EmailMailbox.DRAFT,
  });

  return writeJSON(emailToResponse(email));
});
