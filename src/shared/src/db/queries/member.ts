import { eq, and } from "drizzle-orm";
import { member } from "../schema";
import type { Database } from "../index";

export async function getMemberByUserAndWorkspace(
  db: Database,
  userId: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function listMembers(db: Database, workspaceId: string) {
  return db.select().from(member).where(eq(member.workspaceId, workspaceId));
}

export async function createMember(
  db: Database,
  data: { workspaceId: string; userId: string; role: string }
) {
  const rows = await db
    .insert(member)
    .values({
      workspaceId: data.workspaceId,
      userId: data.userId,
      role: data.role,
    })
    .returning();
  return rows[0]!;
}
