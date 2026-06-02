import { eq, and, gt, asc, notInArray } from "drizzle-orm";
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
      // Exclude tool-result/tool-use/thinking from the READ side only: the UI
      // doesn't render them. They ARE still written (see daemon messages route)
      // and retained for future data analysis — do NOT take this filter as a
      // sign the rows are dead and stop persisting them.
      .where(and(eq(taskMessage.taskId, taskId), eq(agentTaskQueue.workspaceId, workspaceId), notInArray(taskMessage.type, ["tool-result", "tool-use", "thinking"])))
      .orderBy(asc(taskMessage.seq));
  }
  return db
    .select()
    .from(taskMessage)
    // Read-side UI exclusion only; rows are still stored for analysis (see above).
    .where(and(eq(taskMessage.taskId, taskId), notInArray(taskMessage.type, ["tool-result", "tool-use", "thinking"])))
    .orderBy(asc(taskMessage.seq));
}

// Errors-only, workspace-scoped: the chat init routes preload only `type:"error"`
// rows so a persisted error survives a reload (the rest of a run's messages arrive
// live via the task.messages WS broadcast / send-dm). Filtering in SQL keeps the
// route's hot path lean and the workspace join enforces scoping. Kept separate
// from listTaskMessages (which is the UI-exclusion read) on purpose.
export async function listTaskErrorMessages(
  db: Database,
  taskId: string,
  workspaceId: string
) {
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
    .where(
      and(
        eq(taskMessage.taskId, taskId),
        eq(agentTaskQueue.workspaceId, workspaceId),
        eq(taskMessage.type, "error")
      )
    )
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
    // Read-side UI exclusion only; rows are still stored for analysis (see listTaskMessages).
    .where(and(eq(taskMessage.taskId, taskId), gt(taskMessage.seq, afterSeq), notInArray(taskMessage.type, ["tool-result", "tool-use", "thinking"])))
    .orderBy(asc(taskMessage.seq));
}

export async function deleteTaskMessages(db: Database, taskId: string) {
  await db.delete(taskMessage).where(eq(taskMessage.taskId, taskId));
}
