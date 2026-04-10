import { eq, asc } from "drizzle-orm";
import { workspace, member } from "../schema";
import type { Database } from "../index";

export async function getWorkspace(db: Database, id: string) {
  const rows = await db.select().from(workspace).where(eq(workspace.id, id));
  return rows[0] ?? null;
}

export async function listWorkspaces(db: Database, userId: string) {
  return db
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })
    .from(workspace)
    .innerJoin(member, eq(member.workspaceId, workspace.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(workspace.createdAt));
}

export async function createWorkspace(
  db: Database,
  data: { name: string; slug: string }
) {
  const rows = await db
    .insert(workspace)
    .values({ name: data.name, slug: data.slug })
    .returning();
  return rows[0]!;
}
