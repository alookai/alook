# Phase 2a — Web Service

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Migrate the web service to D1 + Better Auth + OpenNext. All API routes adapted for shared imports.

**Strategy:** Config files from spec-plans. Auth/session/broadcast from spec-plans. API routes from main, adapted to import from `@alook/shared` instead of local `lib/db/`.

**Depends on:** Phase 1 (shared library must be complete)

---

### Task 1: D1 migration SQL

**Files:**
- Create: `src/web/migrations/0001_schema.sql`

- [ ] Copy from spec-plans:

```bash
mkdir -p src/web/migrations
cp temp/spec-plans/src/web/migrations/0001_schema.sql src/web/migrations/
```

Review the SQL to ensure it matches the Drizzle schema created in Phase 1 Task 5. The spec-plans migration covers Better Auth tables + application tables.

- [ ] Commit

```bash
git add src/web/migrations/
git commit -m "feat(web): D1 schema migration SQL"
```

---

### Task 2: Auth and session libraries from spec-plans

**Files:**
- Create: `src/web/src/lib/auth.ts`
- Create: `src/web/src/lib/auth-client.ts`
- Create: `src/web/src/lib/session.ts`
- Create: `src/web/src/lib/dual-auth.ts`
- Create: `src/web/src/lib/api-auth.ts`

- [ ] Copy from spec-plans:

```bash
mkdir -p src/web/src/lib
cp temp/spec-plans/src/web/src/lib/auth.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/auth-client.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/session.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/dual-auth.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/api-auth.ts src/web/src/lib/
```

- [ ] Update `src/web/src/lib/dual-auth.ts` to use shared queries instead of local `getDb`. Replace the raw D1 `getDb` import with:

```typescript
import { createDb, queries } from "@alook/shared"
```

Then use `queries.machineToken.getMachineTokenByHash(db, hashedToken)` and `queries.machineToken.updateMachineTokenLastUsed(db, mt.id)` instead of the local getDb approach.

- [ ] Commit

```bash
git add src/web/src/lib/auth.ts src/web/src/lib/auth-client.ts src/web/src/lib/session.ts src/web/src/lib/dual-auth.ts src/web/src/lib/api-auth.ts
git commit -m "feat(web): auth, session, dual-auth from spec-plans"
```

---

### Task 3: Broadcast, storage, utils from spec-plans

**Files:**
- Create: `src/web/src/lib/broadcast.ts`
- Create: `src/web/src/lib/storage.ts`
- Create: `src/web/src/lib/utils.ts`

- [ ] Copy from spec-plans:

```bash
cp temp/spec-plans/src/web/src/lib/broadcast.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/storage.ts src/web/src/lib/
cp temp/spec-plans/src/web/src/lib/utils.ts src/web/src/lib/
```

- [ ] Commit

```bash
git add src/web/src/lib/broadcast.ts src/web/src/lib/storage.ts src/web/src/lib/utils.ts
git commit -m "feat(web): broadcast, storage, utils from spec-plans"
```

---

### Task 4: Middleware from main (adapted)

**Files:**
- Create: `src/web/src/lib/middleware/auth.ts`
- Create: `src/web/src/lib/middleware/helpers.ts`
- Create: `src/web/src/lib/middleware/workspace.ts`
- Create: `src/web/src/lib/middleware/request-id.ts`
- Create: `src/web/src/lib/middleware/request-logger.ts`

- [ ] Copy from main:

```bash
mkdir -p src/web/src/lib/middleware
cp temp/main/src/web/lib/middleware/helpers.ts src/web/src/lib/middleware/
cp temp/main/src/web/lib/middleware/request-id.ts src/web/src/lib/middleware/
cp temp/main/src/web/lib/middleware/request-logger.ts src/web/src/lib/middleware/
```

- [ ] `helpers.ts`, `request-id.ts`, `request-logger.ts` — these are pure Next.js utilities with no DB dependency. Copy as-is. Fix import paths if needed (main uses `@/lib/...` which maps to `src/web/src/lib/...` — same in the new structure since tsconfig paths `@/*` maps to `./src/*`).

- [ ] **Rewrite `auth.ts`:** Main's `withAuth` uses JWT verification. Replace with dual-auth (Better Auth session + machine token). The new `withAuth` should:
  1. Check for `Authorization: Bearer al_*` header → validate via `queries.machineToken.getMachineTokenByHash`
  2. Fall back to Better Auth session via `createAuth(env).api.getSession({ headers })`
  3. Return `AuthContext` with `userId`, `email`, `workspaceId` (for machine tokens)

Reference `temp/main/src/web/lib/middleware/auth.ts` for the `withAuth` wrapper pattern and `AuthContext` interface. Reference `temp/spec-plans/src/web/src/lib/dual-auth.ts` for the D1/Better Auth auth logic.

- [ ] **Rewrite `workspace.ts`:** Main's version imports `db` from `"@/lib/db"` (global PostgreSQL). Replace with getting DB from Cloudflare context:

```typescript
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
```

Use `queries.member.getMemberByUserAndWorkspace(db, auth.userId, workspaceId)`.

- [ ] Commit

```bash
git add src/web/src/lib/middleware/
git commit -m "feat(web): middleware adapted for D1/Better Auth"
```

---

### Task 5: Services and response formatters from main

**Files:**
- Create: `src/web/src/lib/services/task.ts`
- Create: `src/web/src/lib/api/responses.ts`
- Create: `src/web/src/lib/errors.ts`
- Create: `src/web/src/lib/logger.ts`

- [ ] Copy from main:

```bash
mkdir -p src/web/src/lib/services src/web/src/lib/api
cp temp/main/src/web/lib/services/task.ts src/web/src/lib/services/
cp temp/main/src/web/lib/api/responses.ts src/web/src/lib/api/
cp temp/main/src/web/lib/errors.ts src/web/src/lib/errors.ts 2>/dev/null || true
cp temp/main/src/web/lib/logger.ts src/web/src/lib/logger.ts 2>/dev/null || true
```

- [ ] **Adapt `task.ts`:** Change imports from local DB queries to shared:

```typescript
import type { Database } from "@alook/shared"
import { queries } from "@alook/shared"
```

Replace `import * as taskQueries from "../db/queries/task"` with `const taskQueries = queries.task`, etc. The `TaskService` constructor takes `db: Database` — this stays the same.

- [ ] **`responses.ts`:** No changes needed — it uses `formatTimestamp` from helpers and types from `@alook/shared`.

- [ ] Commit

```bash
git add src/web/src/lib/services/ src/web/src/lib/api/ src/web/src/lib/errors.ts src/web/src/lib/logger.ts
git commit -m "feat(web): task service, response formatters, errors, logger"
```

---

### Task 6: Next.js middleware from spec-plans

**Files:**
- Create: `src/web/src/middleware.ts`

- [ ] Copy from spec-plans:

```bash
cp temp/spec-plans/src/web/src/middleware.ts src/web/src/
```

This guards `/dashboard/*` routes with Better Auth session check. Works as-is.

- [ ] Commit

```bash
git add src/web/src/middleware.ts
git commit -m "feat(web): Next.js auth middleware"
```

---

### Task 7: API routes — auth, health, me

**Files:**
- Create: `src/web/src/app/api/auth/[...all]/route.ts`
- Create: `src/web/src/app/api/health/route.ts`
- Create: `src/web/src/app/api/me/route.ts`

- [ ] Copy auth catch-all from spec-plans:

```bash
mkdir -p src/web/src/app/api/auth/\[...all\]
cp temp/spec-plans/src/web/src/app/api/auth/\[...all\]/route.ts src/web/src/app/api/auth/\[...all\]/
```

- [ ] Copy health from main (no auth, no DB):

```bash
mkdir -p src/web/src/app/api/health
cp temp/main/src/web/app/api/health/route.ts src/web/src/app/api/health/
```

- [ ] Copy `/api/me` from main, adapt DB import. Change `import { db } from "@/lib/db"` to get DB from Cloudflare context via `createDb`:

```bash
mkdir -p src/web/src/app/api/me
cp temp/main/src/web/app/api/me/route.ts src/web/src/app/api/me/
```

Edit to use shared queries instead of local DB.

- [ ] Commit

```bash
git add src/web/src/app/api/
git commit -m "feat(web): auth, health, me routes"
```

---

### Task 8: API routes — workspaces, agents, conversations, messages

**Files:**
- Create: `src/web/src/app/api/workspaces/route.ts`
- Create: `src/web/src/app/api/workspaces/[id]/route.ts`
- Create: `src/web/src/app/api/agents/route.ts`
- Create: `src/web/src/app/api/agents/[id]/route.ts`
- Create: `src/web/src/app/api/agents/[id]/conversations/route.ts`
- Create: `src/web/src/app/api/conversations/route.ts`
- Create: `src/web/src/app/api/conversations/[id]/route.ts`
- Create: `src/web/src/app/api/conversations/[id]/messages/route.ts`

- [ ] Copy all from main and adapt each file:

For each route file from `temp/main/src/web/app/api/`:
1. Copy to `src/web/src/app/api/` (note the extra `src/` in path)
2. Replace `import { db } from "@/lib/db"` with getting DB from Cloudflare context
3. Replace `import { someQuery } from "@/lib/db/queries/foo"` with `import { queries, createDb } from "@alook/shared"`
4. Keep the `withAuth` wrapper — it's our adapted middleware

Pattern for each route:
```typescript
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
// ... other imports stay the same

export const GET = withAuth(async (req, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)
  // ... use queries.foo.bar(db, ...) instead of fooQuery(db, ...)
})
```

- [ ] Commit

```bash
git add src/web/src/app/api/
git commit -m "feat(web): workspace, agent, conversation, message routes"
```

---

### Task 9: API routes — daemon endpoints

**Files:**
- Create: `src/web/src/app/api/daemon/register/route.ts`
- Create: `src/web/src/app/api/daemon/deregister/route.ts`
- Create: `src/web/src/app/api/daemon/heartbeat/route.ts`
- Create: `src/web/src/app/api/daemon/runtimes/[runtimeId]/tasks/claim/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/start/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/complete/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/fail/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/progress/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/status/route.ts`
- Create: `src/web/src/app/api/daemon/tasks/[taskId]/messages/route.ts`

- [ ] Copy all daemon routes from main and adapt with same pattern as Task 8.

- [ ] Commit

```bash
git add src/web/src/app/api/daemon/
git commit -m "feat(web): daemon API routes (register, heartbeat, tasks)"
```

---

### Task 10: API routes — tasks, machine-tokens, runtimes

**Files:**
- Create: `src/web/src/app/api/tasks/[id]/route.ts`
- Create: `src/web/src/app/api/tasks/[id]/messages/route.ts`
- Create: `src/web/src/app/api/machine-tokens/route.ts`
- Create: `src/web/src/app/api/machine-tokens/[id]/route.ts`
- Create: `src/web/src/app/api/runtimes/route.ts`
- Create: `src/web/src/app/api/runtimes/machine/route.ts`

- [ ] Copy from main, adapt DB imports.

- [ ] For `machine-tokens/route.ts`: the `generateMachineToken` and `hashToken` functions are in main's `lib/auth/jwt.ts`. Since we're removing jose, extract just these two functions into a new `src/web/src/lib/token.ts`:

```typescript
import { randomBytes, createHash } from "crypto";

export function generateMachineToken(): string {
  const bytes = randomBytes(24);
  return "al_" + bytes.toString("hex");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
```

- [ ] Commit

```bash
git add src/web/src/app/api/tasks/ src/web/src/app/api/machine-tokens/ src/web/src/app/api/runtimes/ src/web/src/lib/token.ts
git commit -m "feat(web): tasks, machine-tokens, runtimes routes + token utils"
```

---

### Task 11: New API routes — email notify, WS token

**Files:**
- Create: `src/web/src/app/api/email/notify/route.ts` (new per migration docs)
- Create: `src/web/src/app/api/ws/token/route.ts` (from spec-plans)

- [ ] Copy WS token route from spec-plans:

```bash
mkdir -p src/web/src/app/api/ws/token
cp temp/spec-plans/src/web/src/app/api/ws/token/route.ts src/web/src/app/api/ws/token/
```

- [ ] Create `POST /api/email/notify` per migration docs (02-email-worker.md). This endpoint is called by the Email Worker via service binding:

```typescript
import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries } from "@alook/shared";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { TaskService } from "@/lib/services/task";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  const db = createDb((env as Env).DB);

  let body: {
    agentId: string;
    r2Key: string;
    from: string;
    subject: string;
    isWhitelisted: boolean;
    forwarded?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  // Create email record
  await queries.email.createEmail(db, {
    agentId: body.agentId,
    fromEmail: body.from,
    toEmail: "", // filled by caller context
    subject: body.subject,
    r2Key: body.r2Key,
    isWhitelisted: body.isWhitelisted,
    forwarded: body.forwarded ?? false,
  });

  // Only create task for whitelisted emails
  if (body.isWhitelisted) {
    const agent = await queries.agent.getAgent(db, body.agentId);
    if (agent && agent.runtimeId) {
      // Create a conversation for this email task
      const conv = await queries.conversation.createConversation(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        userId: agent.ownerId!,
        title: `Email: ${body.subject}`.slice(0, 50),
      });
      const taskService = new TaskService(db);
      await taskService.enqueueTask(
        agent.id, conv.id, agent.workspaceId,
        `New email from ${body.from}: ${body.subject}`
      );
    }
  }

  return writeJSON({ ok: true });
}
```

- [ ] Commit

```bash
git add src/web/src/app/api/email/ src/web/src/app/api/ws/
git commit -m "feat(web): email notify + WS token routes"
```

---

### Task 12: Client-side API wrapper

**Files:**
- Create: `src/web/src/lib/api.ts`

- [ ] Copy from main and adapt for Better Auth (remove JWT header, use cookie auth):

```bash
cp temp/main/src/web/lib/api.ts src/web/src/lib/
```

Edit: Remove `Authorization: Bearer ${token}` header for browser requests (Better Auth sends session cookie automatically). Keep the `X-Workspace-ID` header. Change redirect from `/login` to `/sign-in`.

- [ ] Commit

```bash
git add src/web/src/lib/api.ts
git commit -m "feat(web): client-side API wrapper adapted for Better Auth"
```

**Exit criteria:** All API routes compile. Imports resolve against `@alook/shared`. No direct PostgreSQL references remain.
