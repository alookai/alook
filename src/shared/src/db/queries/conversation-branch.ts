import { and, asc, eq } from "drizzle-orm";
import { conversationBranch, message } from "../schema";
import type { Database } from "../index";

export async function createBranch(
  db: Database,
  data: {
    workspaceId: string;
    parentConversationId: string;
    branchConversationId: string;
    rootMessageId: string;
    provider: string;
    forkSourceTaskId?: string | null;
    forkSourceSessionId?: string | null;
    createdBy: string;
  },
) {
  const rows = await db
    .insert(conversationBranch)
    .values(data)
    .returning();
  return rows[0]!;
}

export async function listBranchesByParent(
  db: Database,
  data: { workspaceId: string; parentConversationId: string },
) {
  return db
    .select()
    .from(conversationBranch)
    .where(
      and(
        eq(conversationBranch.workspaceId, data.workspaceId),
        eq(conversationBranch.parentConversationId, data.parentConversationId),
      ),
    )
    .orderBy(asc(conversationBranch.createdAt));
}

export async function getBranchForRoot(
  db: Database,
  data: {
    workspaceId: string;
    parentConversationId: string;
    rootMessageId: string;
  },
) {
  const rows = await db
    .select()
    .from(conversationBranch)
    .where(
      and(
        eq(conversationBranch.workspaceId, data.workspaceId),
        eq(conversationBranch.parentConversationId, data.parentConversationId),
        eq(conversationBranch.rootMessageId, data.rootMessageId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getBranchByConversation(
  db: Database,
  data: { workspaceId: string; branchConversationId: string },
) {
  const rows = await db
    .select()
    .from(conversationBranch)
    .where(
      and(
        eq(conversationBranch.workspaceId, data.workspaceId),
        eq(conversationBranch.branchConversationId, data.branchConversationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getBranchOrigin(
  db: Database,
  data: { workspaceId: string; branchConversationId: string },
) {
  const rows = await db
    .select({
      branch: conversationBranch,
      rootMessage: message,
    })
    .from(conversationBranch)
    .innerJoin(message, eq(message.id, conversationBranch.rootMessageId))
    .where(
      and(
        eq(conversationBranch.workspaceId, data.workspaceId),
        eq(conversationBranch.branchConversationId, data.branchConversationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
