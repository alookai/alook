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
  }
) {
  const rows = await db.insert(artifact).values(data).returning();
  return rows[0]!;
}

export async function listArtifactsByConversation(
  db: Database,
  conversationId: string,
  workspaceId: string
) {
  return db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.conversationId, conversationId),
        eq(artifact.workspaceId, workspaceId)
      )
    )
    .orderBy(desc(artifact.createdAt));
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
    created_at: row.createdAt,
  };
}
