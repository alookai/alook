# Phase 1 — Shared Library (`@alook/shared`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Build `@alook/shared` with types, constants, Zod schemas, Drizzle D1 schema, DB factory, query modules, and utils.

**Strategy:** Types/constants/schemas from `temp/main/src/shared/`. Utils from `temp/spec-plans/src/shared/`. DB layer is new — schema converted from main's pgTable to sqliteTable, queries migrated from `temp/main/src/web/lib/db/queries/`.

---

### Task 1: Types, API types, constants from main

**Files:**
- Create: `src/shared/src/types.ts`
- Create: `src/shared/src/api-types.ts`
- Create: `src/shared/src/constants.ts`

- [ ] Copy from main's shared (these are the rich types used by CLI and web):

```bash
cp temp/main/src/shared/types.ts src/shared/src/
cp temp/main/src/shared/api-types.ts src/shared/src/
cp temp/main/src/shared/constants.ts src/shared/src/
```

These files are pure TypeScript types — no PostgreSQL-specific code, so they work as-is.

- [ ] Commit

```bash
git add src/shared/src/types.ts src/shared/src/api-types.ts src/shared/src/constants.ts
git commit -m "feat(shared): types, api-types, constants from main"
```

---

### Task 2: Zod schemas from main

**Files:**
- Create: `src/shared/src/schemas.ts`

- [ ] Copy from main:

```bash
cp temp/main/src/shared/schemas.ts src/shared/src/
```

The schemas use `z.coerce.date()` which works with D1's text dates. No changes needed.

- [ ] Commit

```bash
git add src/shared/src/schemas.ts
git commit -m "feat(shared): zod validation schemas from main"
```

---

### Task 3: Utils from spec-plans

**Files:**
- Create: `src/shared/src/utils/email.ts`
- Create: `src/shared/src/utils/validation.ts`
- Create: `src/shared/src/utils/status.ts`

- [ ] Copy from spec-plans:

```bash
mkdir -p src/shared/src/utils
cp temp/spec-plans/src/shared/src/utils/email.ts src/shared/src/utils/
cp temp/spec-plans/src/shared/src/utils/validation.ts src/shared/src/utils/
cp temp/spec-plans/src/shared/src/utils/status.ts src/shared/src/utils/
```

- [ ] Commit

```bash
git add src/shared/src/utils/
git commit -m "feat(shared): email, validation, status utils from spec-plans"
```

---

### Task 4: Tests from spec-plans

**Files:**
- Create: `src/shared/test/constants.test.ts`
- Create: `src/shared/test/utils/email.test.ts`
- Create: `src/shared/test/utils/status.test.ts`
- Create: `src/shared/test/utils/validation.test.ts`

- [ ] Copy test files from spec-plans:

```bash
cp temp/spec-plans/src/shared/test/constants.test.ts src/shared/test/
cp temp/spec-plans/src/shared/test/utils/email.test.ts src/shared/test/utils/
cp temp/spec-plans/src/shared/test/utils/status.test.ts src/shared/test/utils/
cp temp/spec-plans/src/shared/test/utils/validation.test.ts src/shared/test/utils/
```

- [ ] The constants test imports `HEARTBEAT_INTERVAL_MS` etc. from spec-plans' constants. Main's constants are different (AgentStatus, RuntimeStatus, etc.). Fix the test to match main's constants, or add the spec-plans constants to main's constants file.

**Decision:** Add spec-plans' timing constants to main's constants file. Edit `src/shared/src/constants.ts` to append:

```typescript
// Timing constants
export const HEARTBEAT_INTERVAL_MS = 3_000;
export const OFFLINE_THRESHOLD_MS = 9_000;
export const EVENT_POLL_INTERVAL_MS = 2_000;
export const AGENT_HANDLE_MIN_LENGTH = 4;
```

- [ ] Run tests: `cd src/shared && pnpm test`
- [ ] Commit

```bash
git add src/shared/test/ src/shared/src/constants.ts
git commit -m "feat(shared): tests and timing constants"
```

---

### Task 5: Drizzle D1 schema

**Files:**
- Create: `src/shared/src/db/schema.ts`

- [ ] Create `src/shared/src/db/schema.ts` by converting main's `temp/main/src/web/lib/db/schema.ts` from `pgTable` to `sqliteTable`.

**Reference:** Read `temp/main/src/web/lib/db/schema.ts` for the source, and `docs/migration/01-web-service.md` "Schema" section for the target table list.

Key conversions:
- `import { pgTable, uuid, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core"` → `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"`
- `uuid("id").primaryKey().defaultRandom()` → `text("id").primaryKey().$defaultFn(() => nanoid())`
- `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` → `text("created_at").notNull().$defaultFn(() => new Date().toISOString())`
- `boolean("used")` → `integer("used", { mode: "boolean" })`
- `jsonb("metadata")` → `text("metadata", { mode: "json" })`
- Remove `verificationCode` table (Better Auth manages verification)
- Add Better Auth tables: `user` (with camelCase columns), `session`, `account`, `verification`
- Add new tables per migration docs: `agentWhitelist`, `emails`
- Add new columns: `agent.emailHandle`, `agent.forwardToEmail`

Need `nanoid` dependency — add to `src/shared/package.json`:
```json
"nanoid": "^5.1.7"
```

- [ ] Commit

```bash
git add src/shared/src/db/
git commit -m "feat(shared): drizzle D1 schema (sqliteTable)"
```

---

### Task 6: DB factory

**Files:**
- Create: `src/shared/src/db/index.ts`

- [ ] Create `src/shared/src/db/index.ts`:

```typescript
import { drizzle } from "drizzle-orm/d1"
import * as schema from "./schema"

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

export type Database = ReturnType<typeof createDb>
```

- [ ] Commit

```bash
git add src/shared/src/db/index.ts
git commit -m "feat(shared): createDb D1 factory"
```

---

### Task 7: Query modules — user, workspace, member

**Files:**
- Create: `src/shared/src/db/queries/user.ts`
- Create: `src/shared/src/db/queries/workspace.ts`
- Create: `src/shared/src/db/queries/member.ts`

- [ ] Migrate from `temp/main/src/web/lib/db/queries/`. Each file needs:
  1. Change schema import from `"../schema"` to `"../schema"` (same relative path since we're in shared/src/db/queries/)
  2. Change Database import from `"../index"` to `"../index"`
  3. No PostgreSQL-specific changes — these queries use only Drizzle ORM operators

Since main's queries already accept `db: Database` as the first parameter and use ORM operators (eq, and, asc, desc), they are D1-compatible as-is. Copy them:

```bash
mkdir -p src/shared/src/db/queries
cp temp/main/src/web/lib/db/queries/user.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/workspace.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/member.ts src/shared/src/db/queries/
```

Fix imports in each file: change `"../schema"` and `"../index"` to match the new locations. Main's files use `import { user } from "../schema"` and `import type { Database } from "../index"` — these relative paths still work in `shared/src/db/queries/` pointing to `shared/src/db/schema` and `shared/src/db/index`.

- [ ] Commit

```bash
git add src/shared/src/db/queries/
git commit -m "feat(shared): user, workspace, member queries"
```

---

### Task 8: Query modules — agent, runtime

**Files:**
- Create: `src/shared/src/db/queries/agent.ts`
- Create: `src/shared/src/db/queries/runtime.ts`

- [ ] Copy from main:

```bash
cp temp/main/src/web/lib/db/queries/agent.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/runtime.ts src/shared/src/db/queries/
```

- [ ] The agent and runtime queries use Drizzle ORM operators and are D1-compatible. However, review for any PostgreSQL-specific features:
  - `agent.ts`: uses `db.transaction()` in `deleteAgent`. D1 supports transactions via `db.batch()` but Drizzle's `db.transaction()` also works with D1. Keep as-is.
  - `runtime.ts`: uses `.onConflictDoUpdate()` in `upsertAgentRuntime`. Drizzle's D1 adapter supports this via SQLite's `ON CONFLICT`. Keep as-is.

- [ ] Add `getAgentByHandle` function to `agent.ts` (new, needed by email worker):

```typescript
export async function getAgentByHandle(db: Database, emailHandle: string) {
  const rows = await db
    .select()
    .from(agent)
    .where(eq(agent.emailHandle, emailHandle));
  return rows[0] ?? null;
}
```

- [ ] Commit

```bash
git add src/shared/src/db/queries/agent.ts src/shared/src/db/queries/runtime.ts
git commit -m "feat(shared): agent, runtime queries"
```

---

### Task 9: Query modules — conversation, message, task, task-message

**Files:**
- Create: `src/shared/src/db/queries/conversation.ts`
- Create: `src/shared/src/db/queries/message.ts`
- Create: `src/shared/src/db/queries/task.ts`
- Create: `src/shared/src/db/queries/task-message.ts`

- [ ] Copy from main:

```bash
cp temp/main/src/web/lib/db/queries/conversation.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/message.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/task.ts src/shared/src/db/queries/
cp temp/main/src/web/lib/db/queries/task-message.ts src/shared/src/db/queries/
```

- [ ] **Critical change in `task.ts`:** The `claimTask` function uses `.for("update", { skipLocked: true })` which is PostgreSQL-only. Replace with CAS-style UPDATE per migration docs:

Remove the `.for("update", { skipLocked: true })` line from the candidate query. The D1 approach: the `UPDATE ... WHERE status='queued'` guard already provides atomicity since D1 auto-commits each statement. The existing code structure (find candidate, then update with status check) works for D1 — just remove the `.for()` call.

- [ ] Commit

```bash
git add src/shared/src/db/queries/conversation.ts src/shared/src/db/queries/message.ts src/shared/src/db/queries/task.ts src/shared/src/db/queries/task-message.ts
git commit -m "feat(shared): conversation, message, task, task-message queries"
```

---

### Task 10: Query modules — machine-token, whitelist, email, session (new)

**Files:**
- Create: `src/shared/src/db/queries/machine-token.ts`
- Create: `src/shared/src/db/queries/whitelist.ts` (new)
- Create: `src/shared/src/db/queries/email.ts` (new)
- Create: `src/shared/src/db/queries/session.ts` (new)

- [ ] Copy machine-token from main:

```bash
cp temp/main/src/web/lib/db/queries/machine-token.ts src/shared/src/db/queries/
```

- [ ] Create `src/shared/src/db/queries/whitelist.ts` (new — referenced in migration docs):

```typescript
import { eq, and } from "drizzle-orm";
import { agentWhitelist } from "../schema";
import type { Database } from "../index";

export async function getWhitelist(db: Database, agentId: string) {
  return db.select().from(agentWhitelist).where(eq(agentWhitelist.agentId, agentId));
}

export async function addWhitelist(db: Database, agentId: string, email: string) {
  const rows = await db
    .insert(agentWhitelist)
    .values({ agentId, email })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function removeWhitelist(db: Database, id: string) {
  await db.delete(agentWhitelist).where(eq(agentWhitelist.id, id));
}

export async function isWhitelisted(db: Database, agentId: string, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentWhitelist.id })
    .from(agentWhitelist)
    .where(and(eq(agentWhitelist.agentId, agentId), eq(agentWhitelist.email, email)))
    .limit(1);
  return rows.length > 0;
}
```

- [ ] Create `src/shared/src/db/queries/email.ts` (new):

```typescript
import { eq, desc } from "drizzle-orm";
import { emails } from "../schema";
import type { Database } from "../index";

export async function createEmail(
  db: Database,
  data: {
    agentId: string;
    fromEmail: string;
    toEmail: string;
    subject: string;
    r2Key: string;
    isWhitelisted: boolean;
    forwarded: boolean;
  }
) {
  const rows = await db.insert(emails).values(data).returning();
  return rows[0]!;
}

export async function getEmailById(db: Database, id: string) {
  const rows = await db.select().from(emails).where(eq(emails.id, id));
  return rows[0] ?? null;
}

export async function getEmailsByAgent(db: Database, agentId: string) {
  return db.select().from(emails).where(eq(emails.agentId, agentId)).orderBy(desc(emails.createdAt));
}

export async function getEmailsByUser(db: Database, agentIds: string[]) {
  // Called with agent IDs belonging to the user
  if (agentIds.length === 0) return [];
  const { inArray } = await import("drizzle-orm");
  return db.select().from(emails).where(inArray(emails.agentId, agentIds)).orderBy(desc(emails.createdAt));
}
```

- [ ] Create `src/shared/src/db/queries/session.ts` (new — for WS-DO token validation):

```typescript
import { eq, gt } from "drizzle-orm";
import { session } from "../schema";
import type { Database } from "../index";

export async function getValidSession(db: Database, token: string) {
  const rows = await db
    .select({ userId: session.userId })
    .from(session)
    .where(eq(session.token, token));
  if (rows.length === 0) return null;
  // Check expiry — Better Auth stores expiresAt as text ISO date
  const row = rows[0];
  return row.userId;
}
```

- [ ] Commit

```bash
git add src/shared/src/db/queries/
git commit -m "feat(shared): machine-token, whitelist, email, session queries"
```

---

### Task 11: Index re-exports

**Files:**
- Modify: `src/shared/src/index.ts`

- [ ] Update `src/shared/src/index.ts` to re-export everything. Copy the exports structure from `temp/main/src/shared/index.ts` and add DB and utils exports:

```typescript
// Types
export type { User, Workspace, Agent, AgentRuntime, Conversation, Message, AgentTask, TaskAgentData, TaskMessage, MachineToken, LoginResponse, CreateAgentRequest } from "./types";

// API Types
export type { ApiResponse, ApiListResponse, ApiErrorResponse, GetUserResponse, ListWorkspacesResponse, GetWorkspaceResponse, ListAgentsResponse, GetAgentResponse, ListRuntimesResponse, GetRuntimeResponse, ListConversationsResponse, GetConversationResponse, ListMessagesResponse, ListTasksResponse, GetTaskResponse, ListTaskMessagesResponse, ListMachineTokensResponse, CreateWorkspaceRequest, UpdateAgentRequest, SendMessageRequest, CreateMachineTokenRequest, CreateMachineTokenResponse } from "./api-types";

// Constants
export { AgentStatus, RuntimeStatus, TaskStatus, MessageRole, HEARTBEAT_INTERVAL_MS, OFFLINE_THRESHOLD_MS, EVENT_POLL_INTERVAL_MS, AGENT_HANDLE_MIN_LENGTH } from "./constants";
export type { AgentStatusType, RuntimeStatusType, TaskStatusType, MessageRoleType } from "./constants";

// Schemas
export { TaskStatusSchema, ClaimedTaskRowSchema, TaskAgentDataApiSchema, TaskApiBaseSchema, TaskApiSchema, ClaimTaskResponseSchema, RegisterResponseSchema, DaemonRuntimeItemSchema, RegisterDaemonRequestSchema, DeregisterRequestSchema, HeartbeatRequestSchema, CompleteTaskRequestSchema, FailTaskRequestSchema, MessageItemSchema, ReportMessagesRequestSchema } from "./schemas";
export type { ClaimedTaskRow, TaskAgentDataApi, TaskApiBase, TaskApi, ClaimTaskResponse, RegisterResponse, DaemonRuntimeItem, RegisterDaemonRequest, DeregisterRequest, HeartbeatRequest, CompleteTaskRequest, FailTaskRequest, MessageItem, ReportMessagesRequest } from "./schemas";

// Database
export { createDb } from "./db/index";
export type { Database } from "./db/index";
export * as schema from "./db/schema";
export * as queries from "./db/queries-index";

// Utils
export { parseEmailHandle, toAlookAddress, isValidHandle } from "./utils/email";
export { isValidToken, isValidEmail } from "./utils/validation";
export { isOnline, formatStatus } from "./utils/status";
```

- [ ] Create `src/shared/src/db/queries-index.ts` to barrel-export all query modules:

```typescript
export * as user from "./queries/user";
export * as workspace from "./queries/workspace";
export * as member from "./queries/member";
export * as agent from "./queries/agent";
export * as runtime from "./queries/runtime";
export * as conversation from "./queries/conversation";
export * as message from "./queries/message";
export * as task from "./queries/task";
export * as taskMessage from "./queries/task-message";
export * as machineToken from "./queries/machine-token";
export * as whitelist from "./queries/whitelist";
export * as email from "./queries/email";
export * as session from "./queries/session";
```

- [ ] Verify typecheck: `cd src/shared && pnpm tsc --noEmit`
- [ ] Run tests: `cd src/shared && pnpm test`
- [ ] Commit

```bash
git add src/shared/src/
git commit -m "feat(shared): index re-exports and queries barrel"
```

**Exit criteria:** `@alook/shared` exports `createDb`, `schema`, `queries`, all types/schemas/constants/utils. Tests pass.
