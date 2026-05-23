import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  let raw: { ordered_channel_ids?: unknown };
  try {
    raw = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const ids = raw.ordered_channel_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    return writeError("ordered_channel_ids must be a non-empty array of strings", 400);
  }

  if (ids.includes("ch_default")) {
    return writeError("cannot reorder the default channel", 400);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const existing = await queries.channel.listChannels(db, ws.workspaceId);
  const existingIds = new Set(existing.map((c) => c.id));
  for (const id of ids) {
    if (!existingIds.has(id)) return writeError(`Channel ${id} not found`, 400);
  }

  await queries.channel.reorderChannels(db, ws.workspaceId, ids);
  return new Response(null, { status: 204 });
});
