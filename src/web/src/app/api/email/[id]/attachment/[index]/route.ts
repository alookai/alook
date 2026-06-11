import PostalMime from "postal-mime";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, filterDownloadableAttachments } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("email id is required", 400);

  const index = Number(ctx.params?.index);
  if (Number.isNaN(index) || index < 0) return writeError("invalid attachment index", 400);

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  const object = await (env as Env).EMAIL_BUCKET.get(email.r2Key);
  if (!object) return writeError("email content not available", 404);

  const raw = await object.arrayBuffer();
  const parsed = await PostalMime.parse(raw);

  const attachments = filterDownloadableAttachments(parsed.attachments || []);

  if (index >= attachments.length) return writeError("attachment not found", 404);

  const att = attachments[index];
  const filename = att.filename || `attachment-${index}`;
  const contentType = att.mimeType || "application/octet-stream";

  const body = att.content instanceof ArrayBuffer ? new Uint8Array(att.content) : att.content;
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});
