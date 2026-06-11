import PostalMime from "postal-mime";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
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

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  const object = await (env as Env).EMAIL_BUCKET.get(email.r2Key);
  if (!object) {
    return new Response("Email body not available", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const raw = await object.arrayBuffer();
  const parsed = await PostalMime.parse(raw);

  if (parsed.html) {
    return new Response(parsed.html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(parsed.text ?? "", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
