import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, UpdateEmailStatusRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("email id is required", 400);

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  return writeJSON(emailToResponse(email));
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("email id is required", 400);

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  await queries.email.deleteEmail(db, id, ws.workspaceId);

  return new Response(null, { status: 204 });
});

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("email id is required", 400);

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  const [body, valErr] = await parseBody(req, UpdateEmailStatusRequestSchema);
  if (valErr) return valErr;

  const updated = await queries.email.updateEmailStatus(db, id, ws.workspaceId, body.status);
  if (!updated) return writeError("not found", 404);

  return writeJSON(emailToResponse(updated));
});
