import { eq, and } from "drizzle-orm";
import { member, user } from "../schema";
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
  return db
    .select({
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      userName: user.name,
      userEmail: user.email,
      userImage: user.image,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.workspaceId, workspaceId));
}

export async function updateMemberGlobalInstruction(
  db: Database,
  userId: string,
  workspaceId: string,
  globalInstruction: string
) {
  const rows = await db
    .update(member)
    .set({ globalInstruction })
    .where(and(eq(member.userId, userId), eq(member.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
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

export async function getMember(db: Database, memberId: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function deleteMember(db: Database, memberId: string, workspaceId: string) {
  const rows = await db
    .delete(member)
    .where(and(eq(member.id, memberId), eq(member.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}
