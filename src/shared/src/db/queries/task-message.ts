import { eq, and, gt, asc, count, inArray, notInArray } from "drizzle-orm";
import { taskMessage, agentTaskQueue } from "../schema";
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

export async function listTaskMessages(db: Database, taskId: string, workspaceId?: string) {
  if (workspaceId) {
    return db
      .select({
        id: taskMessage.id,
        taskId: taskMessage.taskId,
        seq: taskMessage.seq,
        type: taskMessage.type,
        tool: taskMessage.tool,
        content: taskMessage.content,
        callId: taskMessage.callId,
        input: taskMessage.input,
        output: taskMessage.output,
        createdAt: taskMessage.createdAt,
      })
      .from(taskMessage)
      .innerJoin(agentTaskQueue, eq(taskMessage.taskId, agentTaskQueue.id))
      .where(and(eq(taskMessage.taskId, taskId), eq(agentTaskQueue.workspaceId, workspaceId), notInArray(taskMessage.type, ["tool-result"])))
      .orderBy(asc(taskMessage.seq));
  }
  return db
    .select()
    .from(taskMessage)
    .where(and(eq(taskMessage.taskId, taskId), notInArray(taskMessage.type, ["tool-result"])))
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
    .where(and(eq(taskMessage.taskId, taskId), gt(taskMessage.seq, afterSeq), notInArray(taskMessage.type, ["tool-result"])))
    .orderBy(asc(taskMessage.seq));
}

export async function deleteTaskMessages(db: Database, taskId: string) {
  await db.delete(taskMessage).where(eq(taskMessage.taskId, taskId));
}

const HIDDEN_STEP_TYPES = ["status", "log", "tool-result", "text"];
const CHUNK_SIZE = 50;

export async function countTaskMessagesByTaskIds(
  db: Database,
  taskIds: string[],
  workspaceId: string
): Promise<Array<{ taskId: string; count: number }>> {
  if (taskIds.length === 0) return [];

  const results: Array<{ taskId: string; count: number }> = [];
  for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
    const chunk = taskIds.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .select({
        taskId: taskMessage.taskId,
        count: count(taskMessage.id),
      })
      .from(taskMessage)
      .innerJoin(agentTaskQueue, eq(taskMessage.taskId, agentTaskQueue.id))
      .where(
        and(
          inArray(taskMessage.taskId, chunk),
          eq(agentTaskQueue.workspaceId, workspaceId),
          notInArray(taskMessage.type, HIDDEN_STEP_TYPES)
        )
      )
      .groupBy(taskMessage.taskId);
    results.push(...rows.map((r) => ({ taskId: r.taskId, count: r.count })));
  }

  return results;
}
