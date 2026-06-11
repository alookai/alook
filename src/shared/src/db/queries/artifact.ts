import { eq, desc, and } from "drizzle-orm";
import { artifact } from "../schema";
import type { Database } from "../index";
import type { Artifact } from "../../types";

export async function createArtifact(
  db: Database,
  data: {
    id?: string;
    conversationId: string;
    agentId: string;
    workspaceId: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    thumbnailR2Key?: string;
    source?: string;
  }
) {
  const rows = await db.insert(artifact).values(data).returning();
  return rows[0]!;
}

export async function listArtifactsByConversation(
  db: Database,
  conversationId: string,
  workspaceId: string,
  opts?: { source?: string; limit?: number },
) {
  const conditions = [
    eq(artifact.conversationId, conversationId),
    eq(artifact.workspaceId, workspaceId),
  ];
  if (opts?.source) {
    conditions.push(eq(artifact.source, opts.source));
  }
  let query = db
    .select()
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.createdAt));
  if (opts?.limit != null) {
    query = query.limit(opts.limit) as typeof query;
  }
  return query;
}

export async function getArtifact(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(artifact)
    .where(and(eq(artifact.id, id), eq(artifact.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export function artifactToResponse(row: typeof artifact.$inferSelect): Artifact {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    agent_id: row.agentId,
    filename: row.filename,
    content_type: row.contentType,
    size: row.size,
    source: row.source,
    has_thumbnail: row.thumbnailR2Key != null,
    created_at: row.createdAt,
  };
}
