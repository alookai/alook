import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, DEV_EMAIL_WORKER_URL, DEV_WEB_URL, SendEmailRequestSchema, parseEmailHandle, buildMimeMessage, extractThreadId, buildEmailMapKey } from "@alook/shared";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const cfEnv = env as Env;
  const db = getDb(cfEnv.DB);

  const [body, valErr] = await parseBody(req, SendEmailRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found in workspace", 404);

  let customAccountId = body.customAccountId;
  let fromAddress: string;

  if (body.from && !customAccountId) {
    const alookAddr = agent.emailHandle ? `${agent.emailHandle}@alook.ai` : null;
    if (body.from === alookAddr) {
      fromAddress = alookAddr;
    } else {
      const accounts = await queries.emailAccount.getEmailAccountsByAgent(db, body.agentId, ws.workspaceId);
      const match = accounts.find((a) => a.emailAddress === body.from);
      if (!match) {
        return writeError(`email address '${body.from}' is not configured for this agent`, 400);
      }
      customAccountId = match.id;
      fromAddress = match.emailAddress;
    }
  } else if (customAccountId) {
    const account = await queries.emailAccount.getEmailAccountScoped(db, customAccountId, body.agentId, ws.workspaceId);
    if (!account) {
      return writeError("custom email account not found", 404);
    }
    fromAddress = account.emailAddress;
  } else {
    if (!agent.emailHandle) {
      return writeError("agent has no email handle configured", 400);
    }
    fromAddress = `${agent.emailHandle}@alook.ai`;
  }

  let validatedConversationId: string | undefined;
  if (body.conversationId) {
    const conv = await queries.conversation.getConversation(db, body.conversationId, ws.workspaceId);
    if (conv) validatedConversationId = body.conversationId;
  }

  const attachments = body.attachments ?? [];

  // Local delivery shortcut: same-workspace @alook.ai → @alook.ai
  const senderHandle = parseEmailHandle(fromAddress);
  const recipientHandle = parseEmailHandle(body.to);
  if (senderHandle && recipientHandle) {
    const recipientAgent = await queries.agent.getAgentByHandle(db, recipientHandle);
    if (recipientAgent && recipientAgent.workspaceId === ws.workspaceId) {
      const messageId = `<${nanoid()}@alook.ai>`;
      const htmlBody = body.htmlBody || "";

      const fetchedAttachments: { filename: string; contentType: string; base64: string }[] = [];
      for (const att of attachments) {
        const obj = await cfEnv.EMAIL_BUCKET.get(att.key);
        if (!obj) continue;
        const raw = await obj.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
        fetchedAttachments.push({ filename: att.filename, contentType: att.contentType, base64 });
      }

      const rawMime = buildMimeMessage({
        from: fromAddress,
        to: body.to,
        subject: body.subject,
        messageId,
        inReplyTo: body.inReplyTo,
        references: body.references,
        body: htmlBody,
        bodyType: "text/html",
        attachments: fetchedAttachments,
      });

      const r2Id = nanoid();
      const r2Key = `emails/${r2Id}/raw`;
      await cfEnv.EMAIL_BUCKET.put(r2Key, rawMime, {
        httpMetadata: { contentType: "message/rfc822" },
      });

      const isWhitelisted = await queries.whitelist.isWhitelisted(db, recipientAgent.id, recipientAgent.workspaceId, fromAddress);

      const notifyPayload = JSON.stringify({
        agentId: recipientAgent.id,
        workspaceId: recipientAgent.workspaceId,
        r2Key,
        from: fromAddress,
        to: body.to,
        subject: body.subject,
        isWhitelisted,
        forwarded: false,
        messageId,
        inReplyTo: body.inReplyTo ?? "",
        references: body.references ?? "",
      });
      const notifyInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: notifyPayload };
      let notifyRes: Response;
      try {
        notifyRes = await cfEnv.WORKER_SELF_REFERENCE!.fetch("http://internal/api/email/notify", notifyInit);
      } catch {
        notifyRes = await fetch(`${DEV_WEB_URL}/api/email/notify`, notifyInit);
      }
      if (!notifyRes.ok) {
        const errBody = await notifyRes.text();
        return writeError(`local delivery failed: ${errBody}`, notifyRes.status);
      }

      const email = await queries.email.createEmail(db, {
        agentId: body.agentId,
        workspaceId: ws.workspaceId,
        fromEmail: fromAddress,
        toEmail: body.to,
        subject: body.subject,
        r2Key,
        isWhitelisted: false,
        forwarded: false,
        messageId,
        inReplyTo: body.inReplyTo ?? "",
        references: body.references ?? "",
        htmlBody,
        attachments: JSON.stringify(attachments),
        direction: "outbound",
      });

      if (validatedConversationId) {
        const threadId = extractThreadId(body.references, body.inReplyTo, messageId);
        if (threadId) {
          await queries.conversationMap.createMapping(db, {
            key: buildEmailMapKey(body.agentId, threadId),
            workspaceId: ws.workspaceId,
            conversationId: validatedConversationId,
          });
        }
      }

      return writeJSON(emailToResponse(email));
    }
  }

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
    direction: "outbound",
  });

  if (validatedConversationId && emailResult.messageId) {
    const threadId = extractThreadId(body.references, body.inReplyTo, emailResult.messageId);
    if (threadId) {
      await queries.conversationMap.createMapping(db, {
        key: buildEmailMapKey(body.agentId, threadId),
        workspaceId: ws.workspaceId,
        conversationId: validatedConversationId,
      });
    }
  }

  return writeJSON(emailToResponse(email));
});
