# task_message Tiered Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move task_message content/input/output from D1 to R2 + KV, keeping only metadata in D1, reducing database size from 8GB to <1GB.

**Architecture:** Three-layer storage — D1 holds lightweight metadata (id, task_id, seq, type, tool, call_id, created_at), R2 stores full message arrays per task as JSON files, KV provides read-through caching with 7-day TTL. Write path appends to existing R2/KV data; read path checks KV → R2 → returns empty.

**Tech Stack:** Cloudflare D1, R2, KV (Workers runtime), Drizzle ORM, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/web/src/lib/task-message-store.ts` | TaskMessageStore class — tiered read/write logic (KV → R2) |
| `src/web/src/lib/task-message-store.test.ts` | Unit tests for the store |
| `src/shared/src/db/schema.ts` | Remove content/input/output from taskMessage schema |
| `src/shared/src/db/queries/task-message.ts` | Simplify to metadata-only inserts; remove content reads |
| `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts` | Use store for write + read |
| `src/web/src/app/api/tasks/[id]/messages/route.ts` | Use store for read |
| `src/web/src/app/api/agents/[id]/chat-init/route.ts` | Use store for read |
| `src/web/src/app/api/conversations/[id]/route.ts` | Cleanup R2/KV on conversation delete |
| `src/web/wrangler.toml` | Add TASK_MESSAGE_BUCKET R2 binding |
| `src/web/src/env.d.ts` | Add TASK_MESSAGE_BUCKET type |
| `src/web/src/lib/cache.ts` | Add taskMessages cache key |
| `src/web/migrations/0030_task_message_tiered.sql` | D1 migration to drop content/input/output |
| `scripts/migrate-task-messages-to-r2.ts` | One-off batch migration script |

---

### Task 1: Add R2 Bucket Binding and Type Declarations

**Files:**
- Modify: `src/web/wrangler.toml:57-59`
- Modify: `src/web/src/env.d.ts:4-5`
- Modify: `src/web/src/lib/cache.ts:141-159`

- [ ] **Step 1: Add R2 bucket binding to wrangler.toml**

In `src/web/wrangler.toml`, after the EMAIL_BUCKET binding (line 59), add:

```toml
[[r2_buckets]]
binding = "TASK_MESSAGE_BUCKET"
bucket_name = "alook-task-messages"
```

- [ ] **Step 2: Add TASK_MESSAGE_BUCKET to Env type**

In `src/web/src/env.d.ts`, add after line 4 (`EMAIL_BUCKET: R2Bucket`):

```typescript
TASK_MESSAGE_BUCKET: R2Bucket
```

- [ ] **Step 3: Add cache key for task messages**

In `src/web/src/lib/cache.ts`, add to the `cacheKeys` object:

```typescript
taskMessages: (taskId: string) => `tm:${taskId}`,
```

- [ ] **Step 4: Commit**

```bash
git add src/web/wrangler.toml src/web/src/env.d.ts src/web/src/lib/cache.ts
git commit -m "feat: add TASK_MESSAGE_BUCKET R2 binding and cache key"
```

---

### Task 2: Create TaskMessageStore

**Files:**
- Create: `src/web/src/lib/task-message-store.ts`
- Create: `src/web/src/lib/task-message-store.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/web/src/lib/task-message-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskMessageStore } from "./task-message-store";
import type { TaskMessage } from "@alook/shared";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: any) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function createMockR2() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      if (!val) return null;
      return { text: async () => val } as unknown as R2ObjectBody;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, string> };
}

const msg1: TaskMessage = {
  id: "m1", task_id: "t1", seq: 1, type: "tool-call",
  tool: "Read", call_id: "c1", content: "reading file",
  input: { file_path: "/foo.ts" }, output: "file contents here",
};

const msg2: TaskMessage = {
  id: "m2", task_id: "t1", seq: 2, type: "tool-result",
  tool: "Read", call_id: "c1", content: "", output: "result",
};

const msg3: TaskMessage = {
  id: "m3", task_id: "t1", seq: 3, type: "tool-call",
  tool: "Edit", call_id: "c2", content: "editing",
  input: { file_path: "/bar.ts" }, output: "done",
};

describe("TaskMessageStore", () => {
  let kv: ReturnType<typeof createMockKV>;
  let r2: ReturnType<typeof createMockR2>;
  let store: TaskMessageStore;

  beforeEach(() => {
    kv = createMockKV();
    r2 = createMockR2();
    store = new TaskMessageStore(r2, kv);
  });

  describe("appendMessages", () => {
    it("writes to R2 and KV on first append", async () => {
      await store.appendMessages("t1", [msg1]);

      expect(r2.put).toHaveBeenCalledWith(
        "task-messages/t1.json",
        JSON.stringify([msg1]),
        expect.anything(),
      );
      expect(kv.put).toHaveBeenCalledWith(
        "tm:t1",
        JSON.stringify([msg1]),
        { expirationTtl: 604800 },
      );
    });

    it("appends to existing messages from KV", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1]));

      await store.appendMessages("t1", [msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(2);
      expect(stored[1].id).toBe("m3");
    });

    it("falls back to R2 when KV misses", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      await store.appendMessages("t1", [msg3]);

      const stored = JSON.parse(r2._store.get("task-messages/t1.json")!);
      expect(stored).toHaveLength(2);
    });
  });

  describe("listMessages", () => {
    it("returns from KV on hit", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3]));

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(3);
      expect(r2.get).not.toHaveBeenCalled();
    });

    it("falls back to R2 and populates KV on miss", async () => {
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1, msg3]));

      const result = await store.listMessages("t1");

      expect(result).toHaveLength(2);
      expect(kv.put).toHaveBeenCalledWith(
        "tm:t1",
        JSON.stringify([msg1, msg3]),
        { expirationTtl: 604800 },
      );
    });

    it("returns empty array when neither KV nor R2 has data", async () => {
      const result = await store.listMessages("t1");
      expect(result).toEqual([]);
    });

    it("filters by since parameter", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3]));

      const result = await store.listMessages("t1", { since: 1 });

      expect(result).toHaveLength(2);
      expect(result[0].seq).toBe(2);
    });

    it("filters by excludeTypes", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1, msg2, msg3]));

      const result = await store.listMessages("t1", { excludeTypes: ["tool-result"] });

      expect(result).toHaveLength(2);
      expect(result.every((m) => m.type !== "tool-result")).toBe(true);
    });
  });

  describe("deleteMessages", () => {
    it("deletes from both KV and R2", async () => {
      kv._store.set("tm:t1", JSON.stringify([msg1]));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      await store.deleteMessages("t1");

      expect(kv.delete).toHaveBeenCalledWith("tm:t1");
      expect(r2.delete).toHaveBeenCalledWith("task-messages/t1.json");
    });
  });

  describe("graceful degradation", () => {
    it("works when KV is null", async () => {
      const storeNoKV = new TaskMessageStore(r2, null);
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      const result = await storeNoKV.listMessages("t1");
      expect(result).toHaveLength(1);
    });

    it("falls through when KV read throws", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV down"));
      r2._store.set("task-messages/t1.json", JSON.stringify([msg1]));

      const result = await store.listMessages("t1");
      expect(result).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/web && npx vitest run src/lib/task-message-store.test.ts
```

Expected: FAIL — module `./task-message-store` not found.

- [ ] **Step 3: Implement TaskMessageStore**

Create `src/web/src/lib/task-message-store.ts`:

```typescript
import type { TaskMessage } from "@alook/shared";

const R2_PREFIX = "task-messages/";
const KV_PREFIX = "tm:";
const KV_TTL = 604800; // 7 days

export class TaskMessageStore {
  constructor(
    private r2: R2Bucket,
    private kv: KVNamespace | null,
  ) {}

  async appendMessages(taskId: string, messages: TaskMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const existing = await this.readAll(taskId);
    const updated = [...existing, ...messages];
    const json = JSON.stringify(updated);

    await this.r2.put(`${R2_PREFIX}${taskId}.json`, json, {
      httpMetadata: { contentType: "application/json" },
    });

    if (this.kv) {
      await this.kv.put(`${KV_PREFIX}${taskId}`, json, { expirationTtl: KV_TTL }).catch(() => {});
    }
  }

  async listMessages(
    taskId: string,
    opts?: { since?: number; excludeTypes?: string[] },
  ): Promise<TaskMessage[]> {
    let messages = await this.readAll(taskId);

    if (opts?.since != null) {
      messages = messages.filter((m) => m.seq > opts.since!);
    }
    if (opts?.excludeTypes && opts.excludeTypes.length > 0) {
      const excluded = new Set(opts.excludeTypes);
      messages = messages.filter((m) => !excluded.has(m.type));
    }

    return messages;
  }

  async deleteMessages(taskId: string): Promise<void> {
    await Promise.all([
      this.r2.delete(`${R2_PREFIX}${taskId}.json`),
      this.kv?.delete(`${KV_PREFIX}${taskId}`).catch(() => {}),
    ]);
  }

  private async readAll(taskId: string): Promise<TaskMessage[]> {
    // Try KV first
    if (this.kv) {
      try {
        const raw = await this.kv.get(`${KV_PREFIX}${taskId}`);
        if (raw) return JSON.parse(raw) as TaskMessage[];
      } catch {}
    }

    // Fall back to R2
    const obj = await this.r2.get(`${R2_PREFIX}${taskId}.json`);
    if (!obj) return [];

    const text = await obj.text();
    const messages = JSON.parse(text) as TaskMessage[];

    // Populate KV cache
    if (this.kv) {
      this.kv.put(`${KV_PREFIX}${taskId}`, text, { expirationTtl: KV_TTL }).catch(() => {});
    }

    return messages;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/web && npx vitest run src/lib/task-message-store.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/src/lib/task-message-store.ts src/web/src/lib/task-message-store.test.ts
git commit -m "feat: add TaskMessageStore with KV/R2 tiered storage"
```

---

### Task 3: Wire Store Into Daemon Write Endpoint

**Files:**
- Modify: `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts`

- [ ] **Step 1: Update the POST handler to use the store**

Replace the full content of `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts`:

```typescript
import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import type { TaskMessage } from "@alook/shared"
import { getDb, withD1Retry } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { ReportMessagesRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { TaskMessageStore } from "@/lib/task-message-store";
import { log } from "@/lib/logger";

export const GET = withAuth(async (_req, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const messages = await store.listMessages(taskId, { excludeTypes: ["tool-result"] });
  return writeJSON(messages.map(taskMessageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)
  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const task = await withD1Retry(() => queries.task.getTask(db, taskId, ctx.workspaceId));
  if (!task) {
    return writeError("task not found", 404);
  }

  const [body, err] = await parseBody(req, ReportMessagesRequestSchema);
  if (err) return err;

  if (body.messages.length === 0) {
    return writeJSON({ status: "ok" });
  }

  // Write metadata to D1
  const results = await Promise.allSettled(
    body.messages.map((m) =>
      queries.taskMessage.createTaskMessage(db, {
        taskId,
        seq: m.seq,
        type: m.type,
        tool: m.tool || "",
        callId: m.call_id || "",
        content: m.content || "",
        input: m.input,
        output: m.output || "",
      })
    )
  );

  results.forEach((r) => {
    if (r.status === "rejected") {
      log.warn("Failed to create task message", { taskId, err: r.reason });
    }
  });

  // Write full messages to R2/KV
  const succeeded = body.messages.filter((_, i) => results[i].status === "fulfilled");
  if (succeeded.length > 0) {
    const fullMessages: TaskMessage[] = succeeded.map((m) => ({
      id: "",
      task_id: taskId,
      seq: m.seq,
      type: m.type,
      tool: m.tool || "",
      call_id: m.call_id || "",
      content: m.content || "",
      output: m.output || "",
      ...(m.input ? { input: m.input } : {}),
    }));

    await store.appendMessages(taskId, fullMessages).catch((e) => {
      log.warn("Failed to write task messages to R2/KV", { taskId, err: e });
    });
  }

  // Broadcast
  const broadcastable = succeeded.filter((m) => m.type !== "tool-result");
  if (broadcastable.length > 0) {
    const wsMessages: TaskMessage[] = broadcastable.map((m) => ({
      id: "",
      task_id: taskId,
      seq: m.seq,
      type: m.type,
      tool: m.tool || "",
      call_id: m.call_id || "",
      content: m.content || "",
      output: m.output || "",
      ...(m.input ? { input: m.input } : {}),
    }));
    broadcastToUser(ctx.userId, { type: "task.messages", taskId, messages: wsMessages }).catch(() => {});
  }

  return writeJSON({ status: "ok" });
});
```

- [ ] **Step 2: Verify the code compiles**

```bash
cd src/web && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts
git commit -m "feat: wire TaskMessageStore into daemon messages endpoint"
```

---

### Task 4: Wire Store Into User-Facing Read Endpoints

**Files:**
- Modify: `src/web/src/app/api/tasks/[id]/messages/route.ts`
- Modify: `src/web/src/app/api/agents/[id]/chat-init/route.ts`

- [ ] **Step 1: Update user tasks messages endpoint**

Replace `src/web/src/app/api/tasks/[id]/messages/route.ts`:

```typescript
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { TaskMessageStore } from "@/lib/task-message-store";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("task id is required", 400);
  }

  const task = await queries.task.getTask(db, id, ws.workspaceId);
  if (!task) {
    return writeError("task not found", 404);
  }

  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const sinceParam = req.nextUrl.searchParams.get("since");
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;

  if (sinceParam && isNaN(since!)) {
    return writeError("invalid since parameter", 400);
  }

  const messages = await store.listMessages(id, {
    since,
    excludeTypes: ["tool-result"],
  });

  return writeJSON(messages.map(taskMessageToResponse));
});
```

- [ ] **Step 2: Update chat-init to use store**

In `src/web/src/app/api/agents/[id]/chat-init/route.ts`, add import at the top:

```typescript
import { TaskMessageStore } from "@/lib/task-message-store";
```

Replace the task messages loading section (lines 99-113):

```typescript
  let taskMessages: unknown[] = [];
  if (
    resolvedActiveTask &&
    !["completed", "failed", "cancelled", "superseded"].includes(resolvedActiveTask.status)
  ) {
    try {
      const store = new TaskMessageStore(
        (env as Env).TASK_MESSAGE_BUCKET,
        (env as Env).CACHE_KV ?? null,
      );
      const tmsgs = await store.listMessages(resolvedActiveTask.id, {
        excludeTypes: ["tool-result"],
      });
      taskMessages = tmsgs.map(taskMessageToResponse);
    } catch {
      // non-critical — frontend will recover via polling
    }
  }
```

- [ ] **Step 3: Verify compilation**

```bash
cd src/web && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/src/app/api/tasks/[id]/messages/route.ts src/web/src/app/api/agents/[id]/chat-init/route.ts
git commit -m "feat: wire TaskMessageStore into user-facing read endpoints"
```

---

### Task 5: Add R2/KV Cleanup on Task Deletion

**Files:**
- Modify: `src/web/src/app/api/conversations/[id]/route.ts`

- [ ] **Step 1: Update conversation delete to clean up R2/KV**

In `src/web/src/app/api/conversations/[id]/route.ts`, add imports:

```typescript
import { TaskMessageStore } from "@/lib/task-message-store";
```

Update the DELETE handler to clean up R2/KV before deleting tasks. Replace the delete section:

```typescript
  // Delete task messages from R2/KV before cascade
  const deletedTasks = await queries.task.deleteTasksByConversation(db, id, ws.workspaceId);
  if (deletedTasks.length > 0) {
    const store = new TaskMessageStore(
      (env as Env).TASK_MESSAGE_BUCKET,
      (env as Env).CACHE_KV ?? null,
    );
    await Promise.all(
      deletedTasks.map((t) => store.deleteMessages(t.id).catch(() => {}))
    );
  }
  // Messages cascade automatically via schema
  await queries.conversation.deleteConversation(db, id, ws.workspaceId);
```

Note: The `deleteTasksByConversation` already returns `{ id }` from `.returning()`, so we can use those IDs directly.

- [ ] **Step 2: Verify compilation**

```bash
cd src/web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/web/src/app/api/conversations/[id]/route.ts
git commit -m "feat: clean up R2/KV task messages on conversation delete"
```

---

### Task 6: D1 Migration — Remove Heavy Columns

**Files:**
- Create: `src/web/migrations/0030_task_message_tiered.sql`
- Modify: `src/shared/src/db/schema.ts:444-464`

- [ ] **Step 1: Create the D1 migration**

Create `src/web/migrations/0030_task_message_tiered.sql`:

```sql
-- Remove content, input, output columns from task_message
-- These are now stored in R2 (task-messages/{taskId}.json)
CREATE TABLE task_message_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO task_message_new (id, task_id, seq, type, tool, call_id, created_at)
  SELECT id, task_id, seq, type, tool, call_id, created_at FROM task_message;

DROP TABLE task_message;
ALTER TABLE task_message_new RENAME TO task_message;

CREATE INDEX idx_task_message_task_seq ON task_message(task_id, seq);
CREATE INDEX idx_task_message_task_created ON task_message(task_id, created_at);
```

- [ ] **Step 2: Update Drizzle schema**

In `src/shared/src/db/schema.ts`, replace the taskMessage definition (lines 444-464):

```typescript
export const taskMessage = sqliteTable(
  "task_message",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTaskQueue.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull().default(""),
    tool: text("tool").notNull().default(""),
    callId: text("call_id").notNull().default(""),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_task_message_task_seq").on(t.taskId, t.seq),
    index("idx_task_message_task_created").on(t.taskId, t.createdAt),
  ]
);
```

- [ ] **Step 3: Update createTaskMessage to metadata-only**

In `src/shared/src/db/queries/task-message.ts`, replace `createTaskMessage`:

```typescript
export async function createTaskMessage(
  db: Database,
  data: {
    taskId: string;
    seq: number;
    type: string;
    tool: string;
    callId?: string;
    content?: string;
    input?: unknown;
    output?: string;
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
    })
    .returning();
  return rows[0]!;
}
```

- [ ] **Step 4: Remove listTaskMessages and listTaskMessagesSince**

These functions are no longer used (store handles reads). In `src/shared/src/db/queries/task-message.ts`, remove the `listTaskMessages` and `listTaskMessagesSince` functions entirely. Keep `countTaskMessagesByTaskIds` and `deleteTaskMessages` (they only use metadata columns).

The final file should be:

```typescript
import { eq, and, count, inArray, notInArray } from "drizzle-orm";
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
    content?: string;
    input?: unknown;
    output?: string;
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
    })
    .returning();
  return rows[0]!;
}

export async function deleteTaskMessages(db: Database, taskId: string) {
  await db.delete(taskMessage).where(eq(taskMessage.taskId, taskId));
}

const HIDDEN_STEP_TYPES = ["status", "log", "tool-result", "text"];
const SQLITE_MAX_PARAMS = 999;
const FIXED_PARAMS = 1 + HIDDEN_STEP_TYPES.length;

export async function countTaskMessagesByTaskIds(
  db: Database,
  taskIds: string[],
  workspaceId: string
): Promise<Array<{ taskId: string; count: number }>> {
  if (taskIds.length === 0) return [];

  const chunkSize = SQLITE_MAX_PARAMS - FIXED_PARAMS;

  if (taskIds.length <= chunkSize) {
    const rows = await db
      .select({
        taskId: taskMessage.taskId,
        count: count(taskMessage.id),
      })
      .from(taskMessage)
      .innerJoin(agentTaskQueue, eq(taskMessage.taskId, agentTaskQueue.id))
      .where(
        and(
          inArray(taskMessage.taskId, taskIds),
          eq(agentTaskQueue.workspaceId, workspaceId),
          notInArray(taskMessage.type, HIDDEN_STEP_TYPES)
        )
      )
      .groupBy(taskMessage.taskId);
    return rows.map((r) => ({ taskId: r.taskId, count: r.count }));
  }

  const results: Array<{ taskId: string; count: number }> = [];
  for (let i = 0; i < taskIds.length; i += chunkSize) {
    const chunk = taskIds.slice(i, i + chunkSize);
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
```

- [ ] **Step 5: Verify compilation and run tests**

```bash
cd /Users/gener/Desktop/alookai/alook && npx turbo run test --filter=@alook/shared --filter=@alook/web
```

Expected: Tests pass (some tests may need adjustment if they reference removed columns — fix those).

- [ ] **Step 6: Commit**

```bash
git add src/web/migrations/0030_task_message_tiered.sql src/shared/src/db/schema.ts src/shared/src/db/queries/task-message.ts
git commit -m "feat: D1 migration removes content/input/output from task_message"
```

---

### Task 7: Batch Migration Script

**Files:**
- Create: `scripts/migrate-task-messages-to-r2.ts`

- [ ] **Step 1: Create the migration script**

Create `scripts/migrate-task-messages-to-r2.ts`:

```typescript
/**
 * One-off script to migrate existing task_message rows from D1 to R2.
 * Run via: npx wrangler d1 execute alook-app --command "SELECT DISTINCT task_id FROM task_message LIMIT 1"
 * Then: npx tsx scripts/migrate-task-messages-to-r2.ts
 *
 * Prerequisites:
 * - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars set
 * - R2 bucket "alook-task-messages" created
 * - D1 database still has content/input/output columns (run BEFORE migration 0030)
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const D1_DATABASE_ID = "1593b87c-d8a8-4cdf-b6c0-c80d94442654";
const R2_BUCKET = "alook-task-messages";

const BATCH_SIZE = 100;
const D1_ROW_LIMIT = 5000;

interface TaskMessageRow {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  tool: string;
  call_id: string;
  content: string;
  input: string | null;
  output: string;
  created_at: string;
}

async function queryD1(sql: string, params: string[] = []): Promise<any[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const json = await res.json() as any;
  if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

async function putR2(key: string, body: string): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`R2 put failed for ${key}: ${res.status}`);
}

async function migrate() {
  console.log("Fetching distinct task IDs...");
  const taskRows = await queryD1("SELECT DISTINCT task_id FROM task_message ORDER BY task_id");
  const taskIds = taskRows.map((r: any) => r.task_id as string);
  console.log(`Found ${taskIds.length} tasks to migrate`);

  let migrated = 0;
  let failed = 0;

  for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
    const batch = taskIds.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (taskId) => {
        try {
          // Fetch all messages for this task
          const rows: TaskMessageRow[] = await queryD1(
            `SELECT id, task_id, seq, type, tool, call_id, content, input, output, created_at
             FROM task_message WHERE task_id = ? ORDER BY seq ASC LIMIT ${D1_ROW_LIMIT}`,
            [taskId]
          );

          const messages = rows.map((r) => ({
            id: r.id,
            task_id: r.task_id,
            seq: r.seq,
            type: r.type,
            tool: r.tool,
            call_id: r.call_id,
            content: r.content,
            input: r.input ? JSON.parse(r.input) : undefined,
            output: r.output,
            created_at: r.created_at,
          }));

          await putR2(`task-messages/${taskId}.json`, JSON.stringify(messages));
          migrated++;
        } catch (err) {
          console.error(`Failed to migrate task ${taskId}:`, err);
          failed++;
        }
      })
    );

    console.log(`Progress: ${i + batch.length}/${taskIds.length} (migrated=${migrated}, failed=${failed})`);
  }

  console.log(`\nDone! Migrated: ${migrated}, Failed: ${failed}`);
}

migrate().catch(console.error);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrate-task-messages-to-r2.ts
git commit -m "feat: add batch migration script for task_message → R2"
```

---

### Task 8: Update Tests for New Architecture

**Files:**
- Modify: `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.test.ts` (if exists)
- Modify: `src/web/src/app/api/agents/[id]/chat-init/route.test.ts`

- [ ] **Step 1: Check for existing route tests and update mocks**

Update any test files that mock `queries.taskMessage.listTaskMessages` to instead mock the TaskMessageStore. In test files using `getCloudflareContext`, add `TASK_MESSAGE_BUCKET` to the mock env:

```typescript
TASK_MESSAGE_BUCKET: {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
},
```

In the chat-init test, update the mock for task messages to work with the store pattern instead of `queries.taskMessage.listTaskMessages`.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/gener/Desktop/alookai/alook && npx turbo run test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "test: update test mocks for tiered task message storage"
```

---

### Task 9: Final Verification and Type Check

**Files:** None new — full project verification.

- [ ] **Step 1: Run full type check**

```bash
cd /Users/gener/Desktop/alookai/alook && npx turbo run lint
```

Expected: No lint errors.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/gener/Desktop/alookai/alook && npx turbo run test
```

Expected: All tests pass.

- [ ] **Step 3: Verify build**

```bash
cd /Users/gener/Desktop/alookai/alook/src/web && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -u && git commit -m "fix: address remaining type/lint issues" || true
```

---

## Deployment Sequence

> **Important**: Do NOT apply migration 0030 until Phase 2 is complete.

1. **Create R2 bucket** on Cloudflare: `wrangler r2 bucket create alook-task-messages`
2. **Deploy code** (Tasks 1-5, 8-9) — this enables dual-write (D1 full + R2/KV) and read from R2/KV with D1 fallback
3. **Run migration script** (Task 7) — backfills all existing task_message data into R2
4. **Verify** — spot-check a few tasks in R2 match D1 content
5. **Apply migration 0030** (Task 6) — drops content/input/output from D1
6. **Monitor** — verify reads still work, D1 size decreases over time

---

## Rollback Plan

If issues arise after deployment:
- **Before migration 0030**: Simply revert the code changes; D1 still has full data
- **After migration 0030**: Data is in R2; revert code to read from R2 only (no D1 fallback needed since columns are gone)
