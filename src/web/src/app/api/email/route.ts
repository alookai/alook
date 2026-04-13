import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = createDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) return writeError("agentId is required", 400);

  const agent = await queries.agent.getAgentInWorkspace(db, agentId, ws.workspaceId);
  if (!agent) return writeError("agent not found in workspace", 404);

  const folder = req.nextUrl.searchParams.get("folder");
  const agentEmail = agent.emailHandle ? `${agent.emailHandle}@alook.ai` : "";

  let emailList;
  if (folder === "inbox" && agentEmail) {
    emailList = await queries.email.getInboxEmails(db, agentId, agentEmail);
  } else if (folder === "sent" && agentEmail) {
    emailList = await queries.email.getSentEmails(db, agentId, agentEmail);
  } else {
    emailList = await queries.email.getEmailsByAgent(db, agentId);
  }

  return writeJSON(emailList.map(emailToResponse));
});
