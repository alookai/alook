import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { broadcastToUser } from "@/lib/broadcast";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const bucket = ctx.env.EMAIL_BUCKET;
  const db = getDb(ctx.env.DB);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return writeError("invalid form data", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return writeError("file is required", 400);
  }

  const conversationId = formData.get("conversation_id");
  if (!conversationId || typeof conversationId !== "string") {
    return writeError("conversation_id is required", 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return writeError("file exceeds 10 MB limit", 413);
  }

  const conv = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
  if (!conv || conv.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  const agentId = conv.agentId;
  const filename = sanitizeFilename(file.name);
  const contentType = file.type || "application/octet-stream";
  const artifactId = "art_" + nanoid();
  const r2Key = `artifacts/${ws.workspaceId}/${agentId}/${conversationId}/${artifactId}/${filename}`;

  await bucket.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType },
  });

  let thumbnailR2Key: string | undefined;
  const thumbnail = formData.get("thumbnail");
  if (thumbnail instanceof File && thumbnail.size <= 50 * 1024) {
    thumbnailR2Key = `artifacts/${ws.workspaceId}/${agentId}/${conversationId}/${artifactId}/thumbnail.jpg`;
    await bucket.put(thumbnailR2Key, await thumbnail.arrayBuffer(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }

  const row = await queries.artifact.createArtifact(db, {
    id: artifactId,
    conversationId,
    agentId,
    workspaceId: ws.workspaceId,
    filename,
    contentType,
    size: file.size,
    r2Key,
    thumbnailR2Key,
  });
  const response = queries.artifact.artifactToResponse(row);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, {
      type: "artifact.uploaded",
      conversationId,
      artifact: response,
    }).catch(() => {});
  }

  return writeJSON(response);
});
