# task_message Tiered Storage — Design Spec

> Migrate task_message from D1-only to D1 (metadata) + R2 (full content) + KV (read-through cache).
> Goal: Reduce D1 from ~8GB to <500MB for 78 users.

---

## Problem

- `task_message` table has 6.3M+ rows, consuming ~7GB of the 8GB D1 database
- Two users alone account for 6.3M rows (4.1M + 2.2M)
- The heavy columns are `content`, `input` (JSON), and `output` — tool call details that can be KB-sized each
- D1 has no per-row compression and charges $0.75/GB-mo beyond 5GB

## Architecture

### Storage Layers

| Layer | What it stores | Key format | Lifecycle |
|-------|---------------|------------|-----------|
| **D1** | Metadata only: id, task_id, seq, type, tool, call_id, created_at | Primary key `id` | Permanent (CASCADE on task delete) |
| **R2** | Full TaskMessage[] per task | `task-messages/{taskId}.json` | Permanent (deleted when task deleted) |
| **KV** | Full TaskMessage[] per task (cache) | `tm:{taskId}` | TTL 7 days, invalidated on write |

### D1 Schema Change

Remove columns: `content`, `input`, `output`

```sql
-- Migration: remove heavy columns from task_message
-- SQLite doesn't support DROP COLUMN well, so recreate the table
CREATE TABLE task_message_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_message_new_task_seq ON task_message_new(task_id, seq);
CREATE INDEX idx_task_message_new_task_created ON task_message_new(task_id, created_at);

INSERT INTO task_message_new (id, task_id, seq, type, tool, call_id, created_at)
  SELECT id, task_id, seq, type, tool, call_id, created_at FROM task_message;

DROP TABLE task_message;
ALTER TABLE task_message_new RENAME TO task_message;
```

### R2 Object Format

Path: `task-messages/{taskId}.json`

```json
[
  {
    "id": "abc123",
    "task_id": "task_xyz",
    "seq": 1,
    "type": "tool-call",
    "tool": "Read",
    "call_id": "call_1",
    "content": "...",
    "input": { "file_path": "/foo/bar.ts" },
    "output": "file contents...",
    "created_at": "2026-05-19T10:00:00.000Z"
  }
]
```

### KV Entry

- **Key**: `tm:{taskId}`
- **Value**: Same JSON array as R2
- **TTL**: 7 days (604800 seconds)
- **Size limit**: KV max value is 25MB — sufficient for even the largest tasks

---

## Write Flow (daemon reports messages)

**Endpoint**: `POST /api/daemon/tasks/[taskId]/messages`

```
1. Write metadata rows to D1 (id, task_id, seq, type, tool, call_id, created_at)
2. Read existing messages:
   a. Try KV `tm:{taskId}`
   b. If KV miss → read R2 `task-messages/{taskId}.json`
   c. If R2 miss → empty array (new task)
3. Append new full messages to the array
4. Write updated array to R2 (PUT)
5. Write updated array to KV (PUT with TTL 7d)
6. Broadcast via WebSocket (unchanged)
```

**Concurrency**: Daemon writes are sequential per task (single agent runtime per task), so no concurrent write conflicts on the same taskId.

---

## Read Flows

### 1. List task messages (chat-init, full load)

**Endpoints**: `GET /api/tasks/[id]/messages`, `GET /api/daemon/tasks/[taskId]/messages`, chat-init

```
1. Read KV `tm:{taskId}`
2. If KV hit → filter by type (exclude tool-result) → return
3. If KV miss → read R2 `task-messages/{taskId}.json`
4. If R2 hit → write to KV (TTL 7d) → filter → return
5. If R2 miss → return empty array
```

### 2. Incremental poll (?since=N)

**Endpoint**: `GET /api/tasks/[id]/messages?since=N`

```
1. Same as above (get full array from KV/R2)
2. Filter: messages where seq > N and type not in excluded
3. Return filtered subset
```

### 3. Count task messages (step-counts)

**Endpoint**: `POST /api/tasks/step-counts`

```
→ Query D1 metadata directly (type column is still in D1)
→ No change to existing query logic
→ countTaskMessagesByTaskIds stays as-is
```

### 4. Stale task detection (max created_at)

```
→ Query D1 metadata directly (created_at is still in D1)
→ No change to existing query in task.ts
```

---

## Delete Flow

When a task is deleted (CASCADE from agent_task_queue):

```
1. D1 CASCADE handles metadata deletion automatically
2. After task deletion, also:
   - Delete KV key `tm:{taskId}`
   - Delete R2 object `task-messages/{taskId}.json`
```

Add cleanup in the task deletion path (or use a separate cleanup job for orphaned R2 objects).

---

## Bindings

### wrangler.toml additions (src/web)

```toml
# Already exists:
# [[kv_namespaces]]
# binding = "CACHE_KV"
# id = "3aaa92b4c2c74185b888977e5552e9bf"

# New R2 bucket for task messages
[[r2_buckets]]
binding = "TASK_MESSAGE_BUCKET"
bucket_name = "alook-task-messages"
```

**Decision**: Reuse existing `CACHE_KV` for task message caching (it's already a general-purpose cache KV). No new KV namespace needed.

---

## Code Changes

### New: `src/shared/src/storage/task-message-store.ts`

Service layer that abstracts the tiered storage:

```typescript
interface TaskMessageStore {
  // Write new messages (D1 metadata + R2 + KV)
  appendMessages(taskId: string, messages: NewTaskMessage[]): Promise<void>;
  
  // Read full list (KV → R2 fallback)
  listMessages(taskId: string, opts?: { since?: number; excludeTypes?: string[] }): Promise<TaskMessage[]>;
  
  // Delete all messages for a task
  deleteMessages(taskId: string): Promise<void>;
}
```

### Modified files

| File | Change |
|------|--------|
| `src/shared/src/db/schema.ts` | Remove content/input/output from taskMessage columns |
| `src/shared/src/db/queries/task-message.ts` | `createTaskMessage` → write metadata only; `listTaskMessages` / `listTaskMessagesSince` → delegate to store; `countTaskMessagesByTaskIds` → unchanged (D1 only); `deleteTaskMessages` → also delete KV + R2 |
| `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts` | POST: use store.appendMessages(); GET: use store.listMessages() |
| `src/web/src/app/api/tasks/[id]/messages/route.ts` | GET: use store.listMessages() |
| `src/web/src/app/api/agents/[id]/chat-init/route.ts` | Use store.listMessages() |
| `src/web/wrangler.toml` | Add TASK_MESSAGE_BUCKET R2 binding |
| `src/web/src/env.d.ts` (or Env type) | Add TASK_MESSAGE_BUCKET: R2Bucket |
| `src/web/migrations/00XX_task_message_tiered.sql` | Schema migration (recreate table without content/input/output) |

---

## Migration Plan (existing 6.3M rows)

### Phase 1: Deploy dual-write (no schema change yet)

- New code writes to both D1 (full row, old schema) AND R2/KV
- Read path: try KV → R2 → fall back to D1 (backwards compatible)
- Deploy and verify R2 writes are working

### Phase 2: Batch migration script

```typescript
// Run via wrangler script or one-off Worker
// Process tasks in batches of 100
const tasks = await db.selectDistinct(taskMessage.taskId).from(taskMessage);

for (const batch of chunk(tasks, 100)) {
  for (const { taskId } of batch) {
    const messages = await db.select().from(taskMessage)
      .where(eq(taskMessage.taskId, taskId))
      .orderBy(asc(taskMessage.seq));
    
    await r2.put(`task-messages/${taskId}.json`, JSON.stringify(messages));
  }
}
```

**Estimated time**: 6.3M rows / ~63K tasks ≈ 63K R2 PUTs. At ~1000/min = ~1 hour.

### Phase 3: Verify and cut over

- Verify R2 object count matches distinct task_id count
- Switch read path to KV → R2 only (remove D1 fallback)
- Deploy D1 migration to drop content/input/output columns
- Run VACUUM (if D1 supports it) to reclaim space

---

## Sizing Estimates

| Layer | After migration |
|-------|----------------|
| D1 | ~6.3M rows × ~150 bytes (metadata) ≈ **~1GB** (down from 8GB) |
| R2 | ~63K objects, total ~7GB (same data, now in R2 at $0.015/GB-mo) |
| KV | Hot cache only, ephemeral (TTL 7d) |

**Cost impact**: 
- D1: saves ~$4.5/mo (7GB × $0.75 → within 5GB free tier)
- R2: adds ~$0.11/mo (7GB × $0.015) + negligible ops cost
- KV: negligible (within free tier reads)
- **Net savings**: ~$4/mo + better query performance

---

## Edge Cases

1. **Very large tasks** (>25MB of messages): Unlikely — 4000 messages × 5KB avg = 20MB. If hit, can split into multiple R2 objects (`task-messages/{taskId}/0.json`, `task-messages/{taskId}/1.json`). Not needed for v1.

2. **R2 write fails**: Log error, D1 metadata is still written. KV won't be populated. Next read will attempt R2 again — if still empty, return empty (data loss for that batch). Mitigation: retry R2 write once.

3. **KV/R2 inconsistency**: KV is always written AFTER R2. If KV write fails, next read will populate from R2. Acceptable eventual consistency.

4. **Concurrent reads during migration**: Phase 1 dual-write ensures D1 fallback works. No data loss during transition.

---

## Out of Scope

- Compressing R2 objects (gzip) — can add later if R2 storage grows
- Archiving old tasks to cheaper storage
- Changing the WebSocket broadcast format
- Frontend changes (API response format unchanged)
