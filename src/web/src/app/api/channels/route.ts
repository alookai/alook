import { NextRequest } from "next/server";
import { queries, isUniqueConstraintError } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { channelToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const channels = await queries.channel.listChannels(db, ws.workspaceId);

  const hasDefault = channels.some((c) => c.name === "default");
  const result = hasDefault
    ? channels
    : [
        {
          id: "ch_default",
          workspaceId: ws.workspaceId,
          name: "default",
          position: 0,
          createdAt: new Date().toISOString(),
        },
        ...channels,
      ];

  return writeJSON(result.map(channelToResponse));
});

const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return writeError("name is required", 400);
  }
  if (name.length > 32) {
    return writeError("name must be 32 characters or less", 400);
  }
  if (name === "default") {
    return writeError("cannot create a channel named 'default'", 400);
  }
  if (!CHANNEL_NAME_RE.test(name)) {
    return writeError("name can only contain letters, digits, dashes, and underscores", 400);
  }

  try {
    const created = await queries.channel.createChannel(db, {
      workspaceId: ws.workspaceId,
      name,
    });
    return writeJSON(channelToResponse(created), 201);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return writeError("a channel with this name already exists", 409);
    }
    throw err;
  }
});
