import { queries, isUniqueConstraintError } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { channelToResponse } from "@/lib/api/responses";

const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const id = ctx.params?.id;
  if (!id) return writeError("channel id is required", 400);

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) return writeError("name is required", 400);
  if (name.length > 32) return writeError("name must be 32 characters or less", 400);
  if (name === "default") return writeError("cannot rename to 'default'", 400);
  if (!CHANNEL_NAME_RE.test(name)) {
    return writeError("name can only contain letters, digits, dashes, and underscores", 400);
  }

  const existing = await queries.channel.getChannelById(db, id, ws.workspaceId);
  if (!existing) return writeError("channel not found", 404);
  if (existing.name === "default") return writeError("cannot rename the default channel", 400);

  try {
    const updated = await queries.channel.renameChannel(db, id, ws.workspaceId, name);
    if (!updated) return writeError("channel not found", 404);
    return writeJSON(channelToResponse(updated));
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return writeError("a channel with this name already exists", 409);
    }
    throw err;
  }
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const id = ctx.params?.id;
  if (!id) return writeError("channel id is required", 400);

  const existing = await queries.channel.getChannelById(db, id, ws.workspaceId);
  if (!existing) return writeError("channel not found", 404);
  if (existing.name === "default") return writeError("cannot delete the default channel", 400);

  await queries.channel.deleteChannel(db, id, ws.workspaceId);

  return writeJSON({ ok: true });
});
