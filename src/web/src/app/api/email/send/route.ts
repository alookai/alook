import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries } from "@alook/shared";
import type { EmailAttachment } from "@alook/shared";
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

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

  const agent = await queries.agent.getAgentInWorkspace(db, body.agentId, ws.workspaceId);
  if (!agent) return writeError("agent not found in workspace", 404);

  if (!agent.emailHandle) {
    return writeError("agent has no email handle configured", 400);
  }

  const fromAddress = `${agent.emailHandle}@alook.ai`;
  const attachments = body.attachments ?? [];

  let raw: string;

  if (attachments.length === 0) {
    // Simple single-part message
    raw = [
      `From: ${fromAddress}`,
      `To: ${body.to}`,
      `Subject: ${body.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      "",
      body.htmlBody || "",
    ].join("\r\n");
  } else {
    // Multipart/mixed with attachments
    const boundary = `----=_Part_${nanoid(16)}`;

    const headers = [
      `From: ${fromAddress}`,
      `To: ${body.to}`,
      `Subject: ${body.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      "",
      body.htmlBody || "",
    ];

    const parts: string[] = [];
    for (const att of attachments) {
      const obj = await cfEnv.EMAIL_BUCKET.get(att.key);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);

      parts.push(
        [
          `--${boundary}`,
          `Content-Type: ${att.contentType}; name="${att.filename}"`,
          `Content-Disposition: attachment; filename="${att.filename}"`,
          `Content-Transfer-Encoding: base64`,
          "",
          b64.match(/.{1,76}/g)?.join("\r\n") ?? b64,
        ].join("\r\n")
      );
    }

    raw = [...headers, ...parts, `--${boundary}--`].join("\r\n");
  }

  // Store raw email in R2
  const r2Id = nanoid();
  const r2Key = `emails/${r2Id}/raw`;
  await cfEnv.EMAIL_BUCKET.put(r2Key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  // Send via Cloudflare SendEmail binding
  await cfEnv.SEND_EMAIL.send({
    from: fromAddress,
    to: body.to,
    subject: body.subject,
    html: body.htmlBody || "",
  });

  // Create DB record
  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    fromEmail: fromAddress,
    toEmail: body.to,
    subject: body.subject,
    r2Key,
    isWhitelisted: false,
    forwarded: false,
    htmlBody: body.htmlBody || "",
    attachments: JSON.stringify(attachments),
  });

  return writeJSON(emailToResponse(email));
});
