import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { EmailMailbox, queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

const VALID_STATUSES = ["unread", "read", "archived", "sent", "draft", "sending", "send_unknown"];
const FOLDER_TO_MAILBOX = {
  inbox: EmailMailbox.INBOX,
  sent: EmailMailbox.SENT,
  draft: EmailMailbox.DRAFT,
  untrust: EmailMailbox.UNTRUST,
} as const;

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) return writeError("agentId is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found in workspace", 404);

  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (status && !VALID_STATUSES.includes(status)) {
    return writeError("invalid status", 400);
  }

  const folder = req.nextUrl.searchParams.get("folder");
  const address = req.nextUrl.searchParams.get("address");
  const agentEmail = address || (agent.emailHandle ? `${agent.emailHandle}@alook.ai` : "");

  const limitParam = req.nextUrl.searchParams.get("limit");
  const offsetParam = req.nextUrl.searchParams.get("offset");
  let pagination: { limit: number; offset: number } | undefined;
  if (limitParam != null) {
    const limit = parseInt(limitParam, 10);
    if (isNaN(limit) || limit < 1 || limit > 100) return writeError("limit must be an integer between 1 and 100", 400);
    const offset = offsetParam != null ? parseInt(offsetParam, 10) : 0;
    if (isNaN(offset) || offset < 0) return writeError("offset must be a non-negative integer", 400);
    pagination = { limit, offset };
  }

  let emailList;
  if (folder === "all") {
    emailList = await queries.email.getEmailsByAgent(db, agentId, ws.workspaceId, status, pagination);
  } else if (!folder || folder in FOLDER_TO_MAILBOX) {
    const mailbox = FOLDER_TO_MAILBOX[(folder || "inbox") as keyof typeof FOLDER_TO_MAILBOX];
    emailList = await queries.email.getEmailsByMailbox(db, agentId, ws.workspaceId, mailbox, {
      status,
      pagination,
      address: agentEmail || undefined,
    });
  } else {
    return writeError("invalid folder", 400);
  }

  return writeJSON(emailList.map(emailToResponse));
});
