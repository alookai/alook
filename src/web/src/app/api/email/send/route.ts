import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, DEV_EMAIL_WORKER_URL, DEV_WEB_URL, SendEmailRequestSchema, parseEmailHandle, buildMimeMessage, extractThreadId, buildEmailMapKey, EmailMailbox } from "@alook/shared";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";
import { resolveEmailSender } from "../sender";

async function broadcastEmailSentEvent(
  db: Parameters<typeof queries.message.createMessage>[0],
  conversationId: string,
  ownerId: string,
  agentId: string,
  to: string,
  subject: string,
  emailId: string,
) {
  const eventContent = `Email sent to ${to}: ${subject}`;
  const metadata = JSON.stringify({ emailId });
  const eventMsg = await queries.message.createMessage(db, {
    conversationId,
    role: "event",
    content: eventContent,
    metadata,
  });
  broadcastToUser(ownerId, {
    type: "conversation.message",
    conversationId,
    message: {
      id: eventMsg.id,
      conversation_id: eventMsg.conversationId,
      role: eventMsg.role as "event",
      content: eventMsg.content,
      task_id: eventMsg.taskId,
      attachment_ids: null,
      metadata: { emailId },
      created_at: eventMsg.createdAt,
    },
  }).catch(() => {});
  broadcastToUser(ownerId, { type: "email.sent", agentId }).catch(() => {});
}

async function persistSentEmail(
  db: Parameters<typeof queries.email.createEmail>[0],
  input: {
    draftEmailId?: string;
    agentId: string;
    workspaceId: string;
    fromAddress: string;
    to: string;
    subject: string;
    r2Key: string;
    messageId: string;
    inReplyTo: string;
    references: string;
    htmlBody: string;
    attachments: { key: string; filename: string; size?: number; contentType: string }[];
  }
) {
  const attachments = JSON.stringify(input.attachments);
  if (input.draftEmailId) {
    return queries.email.finalizeDraftSend(db, {
      id: input.draftEmailId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      patch: {
        r2Key: input.r2Key,
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        htmlBody: input.htmlBody,
        attachments,
        status: "sent",
        mailbox: EmailMailbox.SENT,
      },
    });
  }

  return queries.email.createEmail(db, {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    fromEmail: input.fromAddress,
    toEmail: input.to,
    subject: input.subject,
    r2Key: input.r2Key,
    isWhitelisted: false,
    forwarded: false,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    htmlBody: input.htmlBody,
    attachments,
    direction: "outbound",
    status: "sent",
    mailbox: EmailMailbox.SENT,
  });
}

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

  let validatedConversationId: string | undefined;
  if (body.conversationId) {
    const conv = await queries.conversation.getConversation(db, body.conversationId, ws.workspaceId);
    if (conv) validatedConversationId = body.conversationId;
  }

  let sendTo = body.to;
  let sendSubject = body.subject;
  let sendHtmlBody = body.htmlBody || "";
  let sendInReplyTo = body.inReplyTo ?? "";
  let sendReferences = body.references ?? "";
  let attachments = body.attachments ?? [];
  const draftEmailId = body.draftEmailId;
  let requestedFrom = body.from;
  const claimedDraft = draftEmailId
    ? { id: draftEmailId, agentId: body.agentId, workspaceId: ws.workspaceId }
    : null;
  const restoreClaimedDraft = async () => {
    if (!claimedDraft) return;
    await queries.email.restoreDraftAfterSendFailure(db, claimedDraft);
  };
  const markClaimedDraftUnknown = async () => {
    if (!claimedDraft) return;
    await queries.email.markDraftSendUnknown(db, claimedDraft);
  };

  if (draftEmailId) {
    const draft = await queries.email.claimDraftForSend(db, {
      id: draftEmailId,
      agentId: body.agentId,
      workspaceId: ws.workspaceId,
    });
    if (!draft) return writeError("draft is already sending or sent", 409);

    requestedFrom = draft.fromEmail;
    sendTo = draft.toEmail;
    sendSubject = draft.subject;
    sendHtmlBody = draft.htmlBody || "";
    sendInReplyTo = draft.inReplyTo || "";
    sendReferences = draft.references || "";
    try {
      attachments = JSON.parse(draft.attachments || "[]");
    } catch {
      await restoreClaimedDraft();
      return writeError("failed to parse draft attachments", 500);
    }
  }

  let sender;
  try {
    sender = await resolveEmailSender(db, {
      agent,
      agentId: body.agentId,
      workspaceId: ws.workspaceId,
      from: requestedFrom,
      customAccountId: draftEmailId ? undefined : body.customAccountId,
    });
  } catch {
    await restoreClaimedDraft();
    return writeError("failed to resolve email sender", 500);
  }
  if ("error" in sender) {
    await restoreClaimedDraft();
    return writeError(sender.error ?? "invalid sender", sender.status ?? 400);
  }
  const { fromAddress, customAccountId } = sender;

  // Local delivery shortcut: same-workspace @alook.ai → @alook.ai
  const senderHandle = parseEmailHandle(fromAddress);
  const recipientHandle = parseEmailHandle(sendTo);
  if (senderHandle && recipientHandle) {
    let recipientAgent;
    try {
      recipientAgent = await queries.agent.getAgentByHandle(db, recipientHandle);
    } catch {
      await restoreClaimedDraft();
      return writeError("failed to resolve local recipient", 500);
    }
    if (recipientAgent && recipientAgent.workspaceId === ws.workspaceId) {
      const messageId = `<${nanoid()}@alook.ai>`;

      const fetchedAttachments: { filename: string; contentType: string; base64: string }[] = [];
      let r2Key: string;
      try {
        for (const att of attachments) {
          const obj = await cfEnv.EMAIL_BUCKET.get(att.key);
          if (!obj) continue;
          const raw = await obj.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
          fetchedAttachments.push({ filename: att.filename, contentType: att.contentType, base64 });
        }

        const rawMime = buildMimeMessage({
          from: fromAddress,
          to: sendTo,
          subject: sendSubject,
          messageId,
          inReplyTo: sendInReplyTo,
          references: sendReferences,
          body: sendHtmlBody,
          bodyType: "text/html",
          attachments: fetchedAttachments,
        });

        const r2Id = nanoid();
        r2Key = `emails/${r2Id}/raw`;
        await cfEnv.EMAIL_BUCKET.put(r2Key, rawMime, {
          httpMetadata: { contentType: "message/rfc822" },
        });
      } catch {
        await restoreClaimedDraft();
        return writeError("failed to prepare local delivery", 500);
      }

      let isWhitelisted: boolean;
      try {
        isWhitelisted = await queries.whitelist.isWhitelisted(db, recipientAgent.id, recipientAgent.workspaceId, fromAddress);
      } catch {
        await restoreClaimedDraft();
        return writeError("failed to check recipient whitelist", 500);
      }

      const notifyPayload = JSON.stringify({
        agentId: recipientAgent.id,
        workspaceId: recipientAgent.workspaceId,
        r2Key,
        from: fromAddress,
        to: sendTo,
        subject: sendSubject,
        isWhitelisted,
        forwarded: false,
        messageId,
        inReplyTo: sendInReplyTo,
        references: sendReferences,
        isInternal: true,
        ...(body.traceId ? { traceId: body.traceId } : {}),
        ...(body.sourceTaskId ? { sourceTaskId: body.sourceTaskId } : {}),
      });
      const notifyInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: notifyPayload };
      let notifyRes: Response;
      try {
        notifyRes = await cfEnv.WORKER_SELF_REFERENCE!.fetch("http://internal/api/email/notify", notifyInit);
      } catch {
        try {
          notifyRes = await fetch(`${DEV_WEB_URL}/api/email/notify`, notifyInit);
        } catch {
          await markClaimedDraftUnknown();
          return writeError("local delivery failed after send attempt", 502);
        }
      }
      if (!notifyRes.ok) {
        const errBody = await notifyRes.text();
        await markClaimedDraftUnknown();
        return writeError(`local delivery failed: ${errBody}`, notifyRes.status);
      }

      let email;
      try {
        email = await persistSentEmail(db, {
          draftEmailId,
          agentId: body.agentId,
          workspaceId: ws.workspaceId,
          fromAddress,
          to: sendTo,
          subject: sendSubject,
          r2Key,
          messageId,
          inReplyTo: sendInReplyTo,
          references: sendReferences,
          htmlBody: sendHtmlBody,
          attachments,
        });
      } catch {
        await markClaimedDraftUnknown();
        return writeError("draft send could not be finalized", 500);
      }
      if (!email) {
        await markClaimedDraftUnknown();
        return writeError("draft send could not be finalized", 409);
      }

      invalidate(cacheKeys.overviewEmailStats(ws.workspaceId)).catch(() => {});

      if (validatedConversationId) {
        const threadId = extractThreadId(sendReferences, sendInReplyTo, messageId);
        if (threadId) {
          await queries.conversationMap.createMapping(db, {
            key: buildEmailMapKey(body.agentId, threadId),
            workspaceId: ws.workspaceId,
            conversationId: validatedConversationId,
          });
        }
        if (agent.ownerId) {
          await broadcastEmailSentEvent(db, validatedConversationId, agent.ownerId, body.agentId, sendTo, sendSubject, email.id);
        }
      }

      return writeJSON(emailToResponse(email));
    }
  }

  // Delegate sending + R2 archival to the email worker
  const emailPayload = JSON.stringify({
    agentId: body.agentId,
    workspaceId: ws.workspaceId,
    to: sendTo,
    subject: sendSubject,
    htmlBody: sendHtmlBody,
    inReplyTo: sendInReplyTo,
    references: sendReferences,
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
    try {
      // Service binding not connected — fall back to direct URL (local dev)
      emailRes = await fetch(`${DEV_EMAIL_WORKER_URL}/send/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: emailPayload,
      });
    } catch {
      await markClaimedDraftUnknown();
      return writeError("email worker failed after send attempt", 502);
    }
  }

  if (!emailRes.ok) {
    const errBody = await emailRes.text();
    await markClaimedDraftUnknown();
    return writeError(`email worker error: ${errBody}`, emailRes.status);
  }

  let emailResult: { ok: boolean; r2Key: string; messageId?: string };
  try {
    emailResult = await emailRes.json() as { ok: boolean; r2Key: string; messageId?: string };
  } catch {
    await markClaimedDraftUnknown();
    return writeError("email worker response could not be parsed", 502);
  }

  let email;
  try {
    email = await persistSentEmail(db, {
      draftEmailId,
      agentId: body.agentId,
      workspaceId: ws.workspaceId,
      fromAddress,
      to: sendTo,
      subject: sendSubject,
      r2Key: emailResult.r2Key,
      messageId: emailResult.messageId ?? "",
      inReplyTo: sendInReplyTo,
      references: sendReferences,
      htmlBody: sendHtmlBody,
      attachments,
    });
  } catch {
    await markClaimedDraftUnknown();
    return writeError("draft send could not be finalized", 500);
  }
  if (!email) {
    await markClaimedDraftUnknown();
    return writeError("draft send could not be finalized", 409);
  }

  invalidate(cacheKeys.overviewEmailStats(ws.workspaceId)).catch(() => {});

  if (validatedConversationId && emailResult.messageId) {
    const threadId = extractThreadId(sendReferences, sendInReplyTo, emailResult.messageId);
    if (threadId) {
      await queries.conversationMap.createMapping(db, {
        key: buildEmailMapKey(body.agentId, threadId),
        workspaceId: ws.workspaceId,
        conversationId: validatedConversationId,
      });
    }
    if (agent.ownerId) {
      await broadcastEmailSentEvent(db, validatedConversationId, agent.ownerId, body.agentId, sendTo, sendSubject, email.id);
    }
  }

  return writeJSON(emailToResponse(email));
});
