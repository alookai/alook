import { eq, and, gt, asc } from "drizzle-orm";
import { taskMessage } from "../schema";
import type { Database } from "../index";

export async function createTaskMessage(
  db: Database,
  data: {
    taskId: string;
    seq: number;
    type: string;
    tool: string;
    callId?: string;
    content: string;
    input?: unknown;
    output: string;
  }
) {
  const rows = await db
    .insert(taskMessage)
    .values({
      taskId: data.taskId,
      seq: data.seq,
      type: data.type,
      tool: data.tool,
      callId: data.callId || "",
      content: data.content,
      input: data.input ?? null,
      output: data.output,
    })
    .returning();
  return rows[0]!;
}

export async function listTaskMessages(db: Database, taskId: string) {
  return db
    .select()
    .from(taskMessage)
    .where(eq(taskMessage.taskId, taskId))
    .orderBy(asc(taskMessage.seq));
}

export async function listTaskMessagesSince(
  db: Database,
  taskId: string,
  afterSeq: number
) {
  return db
    .select()
    .from(taskMessage)
    .where(and(eq(taskMessage.taskId, taskId), gt(taskMessage.seq, afterSeq)))
    .orderBy(asc(taskMessage.seq));
}

export async function deleteTaskMessages(db: Database, taskId: string) {
  await db.delete(taskMessage).where(eq(taskMessage.taskId, taskId));
}
