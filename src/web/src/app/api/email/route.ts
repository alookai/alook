import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

const VALID_STATUSES = ["unread", "read", "archived"];

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) return writeError("agentId is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId);
  if (!agent) return writeError("agent not found in workspace", 404);

  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (status && !VALID_STATUSES.includes(status)) {
    return writeError("invalid status", 400);
  }

  const folder = req.nextUrl.searchParams.get("folder");
  const address = req.nextUrl.searchParams.get("address");
  const agentEmail = address || (agent.emailHandle ? `${agent.emailHandle}@alook.ai` : "");

  let emailList;
  if (folder === "inbox" && agentEmail) {
    emailList = await queries.email.getInboxEmails(db, agentId, agentEmail, ws.workspaceId, status);
  } else if (folder === "sent" && agentEmail) {
    emailList = await queries.email.getSentEmails(db, agentId, agentEmail, ws.workspaceId, status);
  } else if (folder === "rejected" && agentEmail) {
    emailList = await queries.email.getRejectedEmails(db, agentId, agentEmail, ws.workspaceId, status);
  } else {
    emailList = await queries.email.getEmailsByAgent(db, agentId, ws.workspaceId, status);
  }

  return writeJSON(emailList.map(emailToResponse));
});
