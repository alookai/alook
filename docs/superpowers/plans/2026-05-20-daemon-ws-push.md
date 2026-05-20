# Daemon WS Push Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's 3s HTTP poll with a real-time WebSocket push channel through the existing WS DO, falling back to a 30s poll when WS is unavailable.

**Architecture:** Extend `ws-do` to support daemon connections (keyed by `daemon:{daemonId}`). Server pushes complete task payloads to daemon via Service Binding → WS DO broadcast. Daemon maintains one WS connection with auto-reconnect. Poll degrades gracefully from 3s→30s when WS is up, reverts on disconnect.

**Tech Stack:** Cloudflare Workers Durable Objects, WebSocket API (client: Node.js `ws` package), TypeScript, Zod schemas

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/src/types.ts` | Modify | Add `DaemonPushMessage` type |
| `src/shared/src/schemas.ts` | Modify | Add `DaemonPushMessageSchema` |
| `src/shared/src/index.ts` | Modify | Export new types/schemas |
| `src/ws-do/src/ws-durable.ts` | Modify | Support daemon connection type + auth |
| `src/ws-do/src/index.ts` | Modify | Add `/broadcast/daemon/{daemonId}` route |
| `src/web/custom-worker.ts` | Modify | Intercept `/api/ws/daemon` upgrade |
| `src/web/src/lib/broadcast.ts` | Modify | Add `broadcastToDaemon()` |
| `src/web/src/lib/services/task-payload-builder.ts` | Create | Extract payload assembly from poll route |
| `src/web/src/lib/services/task-payload-builder.test.ts` | Create | Tests for payload builder |
| `src/web/src/lib/services/task.ts` | Modify | Call push after enqueue |
| `src/web/src/app/api/daemon/tasks/poll/route.ts` | Modify | Use TaskPayloadBuilder, simplify |
| `src/web/src/app/api/agents/[id]/workspace/browse/route.ts` | Modify | Push file_request to daemon |
| `src/cli/daemon/ws-client.ts` | Create | WS client with reconnect logic |
| `src/cli/daemon/ws-client.test.ts` | Create | Tests for WS client |
| `src/cli/daemon/daemon.ts` | Modify | Integrate WS client, dynamic poll interval |

---

## Task 1: Add DaemonPushMessage Types to Shared

**Files:**
- Modify: `src/shared/src/types.ts:289` (after WsMessage)
- Modify: `src/shared/src/schemas.ts:152` (after PollResponseSchema)
- Modify: `src/shared/src/index.ts`

- [ ] **Step 1: Add DaemonPushMessage type**

In `src/shared/src/types.ts`, after the `WorkspaceFileResult` interface (line 297):

```typescript
/** Messages pushed from server to daemon via WebSocket. */
export type DaemonPushMessage =
  | { type: "daemon.tasks"; tasks: TaskApi[] }
  | { type: "daemon.file_requests"; requests: FileRequestItem[] }
  | { type: "daemon.meetings"; meetings: PollMeetingItem[] }
  | { type: "daemon.evict"; workspaceId: string }
  | { type: "daemon.update"; version: string }
  | { type: "daemon.rescan" }
  | { type: "daemon.kill"; taskId: string; targetTaskId: string }
```

Note: `TaskApi`, `FileRequestItem`, and `PollMeetingItem` are already defined in `schemas.ts`.

- [ ] **Step 2: Add DaemonPushMessage schema**

In `src/shared/src/schemas.ts`, after `PollResponseSchema` (line 152):

```typescript
export const DaemonPushMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.tasks"), tasks: z.array(TaskApiSchema) }),
  z.object({ type: z.literal("daemon.file_requests"), requests: z.array(FileRequestItemSchema) }),
  z.object({ type: z.literal("daemon.meetings"), meetings: z.array(PollMeetingItemSchema) }),
  z.object({ type: z.literal("daemon.evict"), workspaceId: z.string() }),
  z.object({ type: z.literal("daemon.update"), version: z.string() }),
  z.object({ type: z.literal("daemon.rescan") }),
  z.object({ type: z.literal("daemon.kill"), taskId: z.string(), targetTaskId: z.string() }),
]);
export type DaemonPushMessageType = z.infer<typeof DaemonPushMessageSchema>;
```

- [ ] **Step 3: Export from index.ts**

Add to the schemas export block:
```typescript
DaemonPushMessageSchema,
```

Add to the types export block:
```typescript
export type { DaemonPushMessage } from "./types";
```

Add to the schemas type export block:
```typescript
DaemonPushMessageType,
```

- [ ] **Step 4: Verify build**

Run: `cd src/shared && pnpm build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/src/types.ts src/shared/src/schemas.ts src/shared/src/index.ts
git commit -m "feat(shared): add DaemonPushMessage types and schema"
```

---

## Task 2: Extend WS DO to Support Daemon Connections

**Files:**
- Modify: `src/ws-do/src/ws-durable.ts`
- Modify: `src/ws-do/src/index.ts`

- [ ] **Step 1: Update ConnectionState in ws-durable.ts**

Replace the existing `ConnectionState` interface:

```typescript
type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; authenticated: boolean }
```

- [ ] **Step 2: Update fetch() to handle daemon auth type**

In the `webSocketMessage` handler, expand auth handling to support both user sessions and daemon machine tokens:

```typescript
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  if (typeof message !== "string") return

  let parsed: unknown
  try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

  const state = ws.deserializeAttachment() as ConnectionState

  const msg = parsed as { type: string; token?: string; machineToken?: string; daemonId?: string }

  if (msg.type === "auth") {
    if (msg.machineToken && msg.daemonId) {
      const valid = await this.validateMachineToken(msg.machineToken, msg.daemonId)
      if (!valid) {
        log.warn("daemon websocket auth failed", { daemonId: msg.daemonId })
        ws.close(1008, "Unauthorized")
        return
      }
      ws.serializeAttachment({ type: "daemon", daemonId: msg.daemonId, authenticated: true } as ConnectionState)
      log.info("daemon websocket authenticated", { daemonId: msg.daemonId })
      ws.send(JSON.stringify({ type: "auth.ok" }))
      return
    }

    const userId = await this.validateToken(msg.token!)
    if (!userId) {
      log.warn("websocket auth failed")
      ws.close(1008, "Unauthorized")
      return
    }
    ws.serializeAttachment({ type: "user", userId, authenticated: true } as ConnectionState)
    log.info("websocket authenticated", { userId })
    ws.send(JSON.stringify({ type: "auth.ok" }))
    return
  }

  if (!state.authenticated) {
    ws.close(1008, "Not authenticated")
    return
  }
}
```

- [ ] **Step 3: Add validateMachineToken method**

```typescript
private async validateMachineToken(token: string, daemonId: string): Promise<boolean> {
  if (!token.startsWith("al_")) return false
  const db = createDb(this.env.DB)
  const mt = await queries.machineToken.getMachineTokenByToken(db, token)
  if (!mt || mt.status !== "active" || !mt.workspaceId) return false
  const runtimes = await queries.runtime.getRuntimeIdsByDaemon(db, daemonId, mt.workspaceId)
  return runtimes.length > 0
}
```

- [ ] **Step 4: Update webSocketClose to detect daemon disconnections**

```typescript
async webSocketClose(ws: WebSocket): Promise<void> {
  const state = ws.deserializeAttachment() as ConnectionState
  if (state?.type === "daemon" && state.authenticated) {
    log.info("daemon websocket closed", { daemonId: state.daemonId })
  }
}
```

- [ ] **Step 5: Update broadcast to work with new ConnectionState**

The `broadcast` method already checks `state.authenticated`. Update it to not filter by type — broadcast sends to all authenticated connections on this DO instance. Since user and daemon DOs are keyed differently (`user:{userId}` vs `daemon:{daemonId}`), they are separate DO instances and won't cross-pollinate.

No code change needed — the existing broadcast logic works as-is because each DO instance only holds connections of one type.

- [ ] **Step 6: Add daemon broadcast route in index.ts**

In `src/ws-do/src/index.ts`, add the daemon broadcast route before the userId check:

```typescript
const daemonBroadcast = url.pathname.match(/^\/broadcast\/daemon\/(.+)$/)
if (daemonBroadcast && request.method === "POST") {
  const daemonId = daemonBroadcast[1]
  const reqLog = log.child({ traceId, daemonId })
  reqLog.debug("broadcasting to daemon")

  const doId = env.WS_DO.idFromName("daemon:" + daemonId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
}
```

- [ ] **Step 7: Add daemon WS upgrade route in index.ts**

Add before the existing userId-based WS upgrade logic:

```typescript
const daemonId = url.searchParams.get("daemonId")
if (daemonId) {
  const reqLog = log.child({ traceId, daemonId })
  reqLog.info("daemon websocket upgrade")

  const doId = env.WS_DO.idFromName("daemon:" + daemonId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(request)
}
```

Move the existing `userId` check below this block (it already returns 400 if no userId, so the daemonId check must come first).

- [ ] **Step 8: Verify build**

Run: `cd src/ws-do && pnpm build`
Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/ws-do/src/ws-durable.ts src/ws-do/src/index.ts
git commit -m "feat(ws-do): support daemon WebSocket connections and broadcast"
```

---

## Task 3: Update custom-worker.ts to Route Daemon WS Upgrades

**Files:**
- Modify: `src/web/custom-worker.ts`

- [ ] **Step 1: Extend WS path matching**

The current logic intercepts `/api/ws` and `/api/ws/*`. Daemon connections will use `/api/ws/daemon?daemonId=xxx`, which already matches `isWsPath`. No code change needed — the existing interceptor already forwards all `/api/ws/*` upgrades to `WS_DO_WORKER`.

Verify by reading the code:
```typescript
const isWsPath = url.pathname === "/api/ws" || url.pathname.startsWith("/api/ws/")
if (isWsUpgrade && isWsPath) {
  return env.WS_DO_WORKER.fetch(request)
}
```

The daemon connects to `/api/ws/daemon?daemonId=xxx` — this matches `startsWith("/api/ws/")` and has the Upgrade header. No change required.

- [ ] **Step 2: Commit (skip if no changes)**

No commit needed for this task — existing routing already works.

---

## Task 4: Add broadcastToDaemon to Web Server

**Files:**
- Modify: `src/web/src/lib/broadcast.ts`

- [ ] **Step 1: Add broadcastToDaemon function**

After the existing `broadcastToAgent` function:

```typescript
export function broadcastToDaemon(daemonId: string, message: unknown): Promise<void> {
  return sendBroadcast(
    `/broadcast/daemon/${daemonId}`,
    JSON.stringify(message),
    { daemonId, type: (message as { type: string }).type },
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/src/lib/broadcast.ts
git commit -m "feat(web): add broadcastToDaemon for WS push to daemon"
```

---

## Task 5: Extract TaskPayloadBuilder Service

**Files:**
- Create: `src/web/src/lib/services/task-payload-builder.ts`
- Create: `src/web/src/lib/services/task-payload-builder.test.ts`
- Modify: `src/web/src/app/api/daemon/tasks/poll/route.ts`

- [ ] **Step 1: Write test for TaskPayloadBuilder**

Create `src/web/src/lib/services/task-payload-builder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAllAgentsForWorkspace: vi.fn() },
      emailAccount: { getAllEmailAccountsForWorkspace: vi.fn() },
      agentLink: { getAllColleaguesForWorkspace: vi.fn() },
      member: { getMemberByUserAndWorkspace: vi.fn() },
      user: { getUser: vi.fn() },
      conversation: { getConversation: vi.fn() },
    },
  };
});

vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  cacheKeys: {
    allAgents: (wsId: string) => `agents:${wsId}`,
    allEmailAccounts: (wsId: string) => `emails:${wsId}`,
    allColleagues: (wsId: string) => `colleagues:${wsId}`,
    member: (wsId: string, uid: string) => `member:${wsId}:${uid}`,
    user: (uid: string) => `user:${uid}`,
  },
}));

import { queries } from "@alook/shared";
import { TaskPayloadBuilder } from "./task-payload-builder";

describe("TaskPayloadBuilder", () => {
  const mockDb = {} as any;
  let builder: TaskPayloadBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new TaskPayloadBuilder(mockDb);
  });

  it("builds payload for a standard task with agent data", async () => {
    const task = {
      id: "t1",
      agentId: "a1",
      runtimeId: "r1",
      workspaceId: "w1",
      conversationId: "c1",
      prompt: "hello",
      status: "queued",
      priority: 0,
      type: "user_dm_message",
      contextKey: null,
      sessionId: null,
      createdAt: new Date(),
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      context: null,
    };

    (queries.agent.getAllAgentsForWorkspace as any).mockResolvedValue([
      { id: "a1", name: "TestAgent", instructions: "do stuff", emailHandle: "test", ownerId: "u1", runtimeConfig: {} },
    ]);
    (queries.emailAccount.getAllEmailAccountsForWorkspace as any).mockResolvedValue([]);
    (queries.agentLink.getAllColleaguesForWorkspace as any).mockResolvedValue([]);
    (queries.member.getMemberByUserAndWorkspace as any).mockResolvedValue(null);
    (queries.user.getUser as any).mockResolvedValue({ name: "Gener", email: "test@test.com" });
    (queries.conversation.getConversation as any).mockResolvedValue({
      id: "c1",
      userId: "u1",
      channel: "default",
    });

    const results = await builder.buildFullPayloads([task], "w1");

    expect(results).toHaveLength(1);
    expect(results[0].agent).not.toBeNull();
    expect(results[0].agent!.name).toBe("TestAgent");
  });

  it("returns kill tasks without agent data", async () => {
    const task = {
      id: "t2",
      agentId: "a1",
      runtimeId: "r1",
      workspaceId: "w1",
      conversationId: "c1",
      prompt: "",
      status: "queued",
      priority: 0,
      type: "kill_task",
      contextKey: null,
      sessionId: null,
      createdAt: new Date(),
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      context: { target_task_id: "t1" },
    };

    (queries.agent.getAllAgentsForWorkspace as any).mockResolvedValue([]);
    (queries.emailAccount.getAllEmailAccountsForWorkspace as any).mockResolvedValue([]);
    (queries.agentLink.getAllColleaguesForWorkspace as any).mockResolvedValue([]);

    const results = await builder.buildFullPayloads([task], "w1");

    expect(results).toHaveLength(1);
    expect(results[0].agent).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && pnpm test -- src/lib/services/task-payload-builder.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create TaskPayloadBuilder**

Create `src/web/src/lib/services/task-payload-builder.ts`:

```typescript
import type { Database } from "@alook/shared";
import { queries, TASK_TYPES, toAlookAddress } from "@alook/shared";
import { taskToResponse } from "@/lib/api/responses";
import { cached, cacheKeys } from "@/lib/cache";

type ClaimedTask = Awaited<ReturnType<typeof queries.task.claimTasksForRuntimes>>[number];

export class TaskPayloadBuilder {
  constructor(private db: Database) {}

  async buildFullPayloads(tasks: ClaimedTask[], workspaceId: string) {
    const nonKillTasks = tasks.filter((t) => t.type !== TASK_TYPES.KILL_TASK);
    const agentIds = [...new Set(nonKillTasks.map((t) => t.agentId))];

    const [allAgents, allEmailAccounts, allColleagues] = agentIds.length > 0
      ? await Promise.all([
          cached(cacheKeys.allAgents(workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(this.db, workspaceId)),
          cached(cacheKeys.allEmailAccounts(workspaceId), 600, () => queries.emailAccount.getAllEmailAccountsForWorkspace(this.db, workspaceId)),
          cached(cacheKeys.allColleagues(workspaceId), 600, () => queries.agentLink.getAllColleaguesForWorkspace(this.db, workspaceId)).catch(() => [] as Awaited<ReturnType<typeof queries.agentLink.getAllColleaguesForWorkspace>>),
        ]).then(([agents, emails, colleagues]) => {
          const agentIdSet = new Set(agentIds);
          return [
            agents.filter((a) => agentIdSet.has(a.id)),
            emails.filter((a) => agentIdSet.has(a.agentId)),
            colleagues.filter((c) => agentIdSet.has(c.agentId)),
          ] as const;
        })
      : [[], [], [] as Awaited<ReturnType<typeof queries.agentLink.getAllColleaguesForWorkspace>>];

    const agentMap = new Map(allAgents.map((a) => [a.id, a]));
    const emailAccountsByAgent = new Map<string, string[]>();
    for (const acc of allEmailAccounts) {
      const list = emailAccountsByAgent.get(acc.agentId) ?? [];
      list.push(acc.emailAddress);
      emailAccountsByAgent.set(acc.agentId, list);
    }
    const colleaguesByAgent = new Map<string, typeof allColleagues>();
    for (const c of allColleagues) {
      const list = colleaguesByAgent.get(c.agentId) ?? [];
      list.push(c);
      colleaguesByAgent.set(c.agentId, list);
    }

    const memberCache = new Map<string, { globalInstruction: string } | null>();
    const userCache = new Map<string, { name: string; email: string } | null>();
    const convoCache = new Map<string, Awaited<ReturnType<typeof queries.conversation.getConversation>> | null>();

    const results = [];
    for (const task of tasks) {
      if (task.type === TASK_TYPES.KILL_TASK) {
        results.push({ ...taskToResponse(task), agent: null, sender: null });
        continue;
      }

      const agent = agentMap.get(task.agentId) ?? null;
      const emailAddresses: string[] = [];
      if (agent) {
        if (agent.emailHandle) emailAddresses.push(`${agent.emailHandle}@alook.ai`);
        const customAccounts = emailAccountsByAgent.get(agent.id) ?? [];
        emailAddresses.push(...customAccounts);
      }

      let instructions = agent?.instructions ?? "";
      if (agent?.ownerId) {
        if (!memberCache.has(agent.ownerId)) {
          const m = await cached(
            cacheKeys.member(workspaceId, agent.ownerId),
            600,
            () => queries.member.getMemberByUserAndWorkspace(this.db, agent.ownerId!, workspaceId),
          );
          memberCache.set(agent.ownerId, m ? { globalInstruction: m.globalInstruction } : null);
        }
        const cachedMember = memberCache.get(agent.ownerId);
        if (cachedMember?.globalInstruction) {
          instructions = [cachedMember.globalInstruction, instructions].filter(Boolean).join("\n\n");
        }
      }

      let ownerName: string | null = null;
      if (agent?.ownerId) {
        if (!userCache.has(agent.ownerId)) {
          const u = await cached(
            cacheKeys.user(agent.ownerId),
            1800,
            () => queries.user.getUser(this.db, agent.ownerId!),
          );
          userCache.set(agent.ownerId, u ? { name: u.name, email: u.email } : null);
        }
        ownerName = userCache.get(agent.ownerId)?.name ?? null;
      }

      let convo = convoCache.get(task.conversationId) ?? null;
      if (task.conversationId && !convoCache.has(task.conversationId)) {
        convo = await queries.conversation.getConversation(this.db, task.conversationId, workspaceId);
        convoCache.set(task.conversationId, convo);
      }
      const taskChannel = convo?.channel ?? "default";

      let sender: { name: string; email: string; is_owner: boolean } | null = null;
      if (task.type === TASK_TYPES.USER_DM_MESSAGE && convo?.userId) {
        if (!userCache.has(convo.userId)) {
          const u = await cached(
            cacheKeys.user(convo.userId),
            1800,
            () => queries.user.getUser(this.db, convo!.userId!),
          );
          userCache.set(convo.userId, u ? { name: u.name, email: u.email } : null);
        }
        const cachedUser = userCache.get(convo.userId);
        if (cachedUser) {
          sender = {
            name: cachedUser.name,
            email: cachedUser.email,
            is_owner: convo.userId === agent?.ownerId,
          };
        }
      }

      const rawColleagues = colleaguesByAgent.get(task.agentId) ?? [];
      const colleagues = rawColleagues.map((c) => ({
        name: c.name,
        email: c.emailHandle ? toAlookAddress(c.emailHandle) : "",
        description: c.description,
        instruction: c.instruction,
      }));

      results.push({
        ...taskToResponse(task),
        channel: taskChannel,
        sender,
        agent: agent
          ? {
              instructions,
              name: agent.name,
              runtime_config: agent.runtimeConfig || {},
              email_handle: agent.emailHandle || null,
              email_addresses: emailAddresses,
              user_email: null as string | null,
              user_name: ownerName,
              colleagues,
            }
          : null,
      });
    }

    return results;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/web && pnpm test -- src/lib/services/task-payload-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor poll route to use TaskPayloadBuilder**

In `src/web/src/app/api/daemon/tasks/poll/route.ts`, replace the ~100 lines of inline payload assembly (lines 106-239) with:

```typescript
import { TaskPayloadBuilder } from "@/lib/services/task-payload-builder";

// ... after task claiming (line 104) ...

const payloadBuilder = new TaskPayloadBuilder(db);
const tasks = await payloadBuilder.buildFullPayloads(claimed, ctx.workspaceId!);

// Patch user_email onto results (only available in poll context where we have ctx.email)
for (const t of tasks) {
  if (t.agent) t.agent.user_email = ctx.email || null;
}
```

Remove the old inline code block (lines 106-239).

- [ ] **Step 6: Run existing poll route tests**

Run: `cd src/web && pnpm test -- src/app/api/daemon/tasks/poll/route.test.ts`
Expected: PASS (behavior unchanged)

- [ ] **Step 7: Commit**

```bash
git add src/web/src/lib/services/task-payload-builder.ts src/web/src/lib/services/task-payload-builder.test.ts src/web/src/app/api/daemon/tasks/poll/route.ts
git commit -m "refactor(web): extract TaskPayloadBuilder from poll route"
```

---

## Task 6: Push Tasks to Daemon on Enqueue

**Files:**
- Modify: `src/web/src/lib/services/task.ts`
- Modify: `src/web/src/app/api/agents/[id]/workspace/browse/route.ts`

- [ ] **Step 1: Add push logic to TaskService.enqueueTask()**

In `src/web/src/lib/services/task.ts`, after `invalidate(cacheKeys.activeTaskCounts(workspaceId))` (line 53):

```typescript
import { broadcastToDaemon } from "@/lib/broadcast";
import { TaskPayloadBuilder } from "@/lib/services/task-payload-builder";
import { queries as sharedQueries } from "@alook/shared";
```

Add at the end of `enqueueTask`, after `invalidate`:

```typescript
// Push task to daemon via WS (best-effort, non-blocking)
this.pushTaskToDaemon(task, agentId, workspaceId).catch(() => {});
```

Add new private method:

```typescript
private async pushTaskToDaemon(
  task: { id: string; agentId: string; runtimeId: string; workspaceId: string; conversationId: string; prompt: string; status: string; priority: number; type: string; contextKey?: string | null; context?: unknown; createdAt: Date; dispatchedAt: Date | null; startedAt: Date | null; completedAt: Date | null; result: unknown; error: string | null; sessionId: string | null },
  agentId: string,
  workspaceId: string,
) {
  const runtime = await sharedQueries.runtime.getAgentRuntime(this.db, task.runtimeId);
  if (!runtime) return;

  const builder = new TaskPayloadBuilder(this.db);
  const payloads = await builder.buildFullPayloads([task as any], workspaceId);
  if (payloads.length === 0) return;

  broadcastToDaemon(runtime.daemonId, {
    type: "daemon.tasks",
    tasks: payloads,
  });
}
```

- [ ] **Step 2: Push file_requests to daemon**

In `src/web/src/app/api/agents/[id]/workspace/browse/route.ts`, after the KV put (line 34):

```typescript
import { broadcastToDaemon } from "@/lib/broadcast";
import { queries } from "@alook/shared";
```

After `kv.put(...)`:

```typescript
// Push file request to daemon (best-effort)
const runtime = agent.runtimeId
  ? await queries.runtime.getAgentRuntime(db, agent.runtimeId)
  : null;
if (runtime) {
  broadcastToDaemon(runtime.daemonId, {
    type: "daemon.file_requests",
    requests: [{ id: row.id, agent_id: agentId, request_type: body.request_type, path: body.path }],
  }).catch(() => {});
}
```

- [ ] **Step 3: Run tests**

Run: `cd src/web && pnpm test -- src/lib/services/task.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/web/src/lib/services/task.ts src/web/src/app/api/agents/[id]/workspace/browse/route.ts
git commit -m "feat(web): push tasks and file_requests to daemon via WS"
```

---

## Task 7: Create Daemon WS Client

**Files:**
- Create: `src/cli/daemon/ws-client.ts`
- Create: `src/cli/daemon/ws-client.test.ts`

- [ ] **Step 1: Write test for WS client**

Create `src/cli/daemon/ws-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaemonWsClient } from "./ws-client.js";

describe("DaemonWsClient", () => {
  it("constructs URL correctly", () => {
    const client = new DaemonWsClient({
      serverURL: "https://alook.ai",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.getUrl()).toBe("wss://alook.ai/api/ws/daemon?daemonId=my-host");
  });

  it("constructs local URL correctly", () => {
    const client = new DaemonWsClient({
      serverURL: "http://localhost:3000",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.getUrl()).toBe("ws://localhost:8789/?daemonId=my-host");
  });

  it("reports disconnected initially", () => {
    const client = new DaemonWsClient({
      serverURL: "https://alook.ai",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.isConnected()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/cli && pnpm test -- daemon/ws-client.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement DaemonWsClient**

Create `src/cli/daemon/ws-client.ts`:

```typescript
import WebSocket from "ws";
import { createLogger } from "../lib/logger.js";
import type { DaemonPushMessage } from "@alook/shared";

const log = createLogger({ module: "ws-client" });

const WS_RECONNECT_INIT = 1000;
const WS_RECONNECT_MAX = 30_000;
const WS_PING_INTERVAL = 25_000;
const WS_LIVENESS_TIMEOUT = 30_000;
const WS_DO_DEV_PORT = 8789;

export interface DaemonWsClientOptions {
  serverURL: string;
  daemonId: string;
  machineToken: string;
  onMessage: (msg: DaemonPushMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = WS_RECONNECT_INIT;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private connected = false;
  private closed = false;

  constructor(private opts: DaemonWsClientOptions) {}

  getUrl(): string {
    const url = new URL(this.opts.serverURL);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocal) {
      return `ws://localhost:${WS_DO_DEV_PORT}/?daemonId=${this.opts.daemonId}`;
    }
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/api/ws/daemon?daemonId=${this.opts.daemonId}`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.closed) return;
    this.cleanup();

    const wsUrl = this.getUrl();
    log.info("connecting", { url: wsUrl });

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      log.warn("ws creation failed", { err: String(err) });
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectDelay = WS_RECONNECT_INIT;
      this.ws!.send(JSON.stringify({
        type: "auth",
        machineToken: this.opts.machineToken,
        daemonId: this.opts.daemonId,
      }));
      this.lastMessageAt = Date.now();
      this.startHeartbeat();
    });

    this.ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
      const str = data.toString();
      if (str === "pong") return;

      try {
        const msg = JSON.parse(str);
        if (msg.type === "auth.ok") {
          log.info("authenticated");
          this.connected = true;
          this.opts.onConnected();
          return;
        }
        this.opts.onMessage(msg as DaemonPushMessage);
      } catch (err) {
        log.debug("message parse error", { err: String(err) });
      }
    });

    this.ws.on("error", (err) => {
      log.debug("ws error", { err: String(err) });
    });

    this.ws.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      if (wasConnected) {
        this.opts.onDisconnected();
      }
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });
  }

  close(): void {
    this.closed = true;
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.reconnectDelay, WS_RECONNECT_MAX);
    this.reconnectDelay = Math.min(delay * 2, WS_RECONNECT_MAX);
    const jitter = Math.random() * 500;
    log.debug("reconnecting", { delay: delay + jitter });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + jitter);
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, WS_PING_INTERVAL);

    this.livenessInterval = setInterval(() => {
      if (Date.now() - this.lastMessageAt > WS_LIVENESS_TIMEOUT) {
        log.warn("liveness timeout, closing");
        this.ws?.close();
      }
    }, 5_000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.livenessInterval) { clearInterval(this.livenessInterval); this.livenessInterval = null; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/cli && pnpm test -- daemon/ws-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/daemon/ws-client.ts src/cli/daemon/ws-client.test.ts
git commit -m "feat(cli): add DaemonWsClient with reconnect and heartbeat"
```

---

## Task 8: Integrate WS Client into Daemon

**Files:**
- Modify: `src/cli/daemon/daemon.ts`
- Modify: `src/cli/daemon/config.ts`

- [ ] **Step 1: Add WS poll intervals to config**

In `src/cli/daemon/config.ts`, add to `DaemonConfig` interface:

```typescript
wsPollInterval: number;   // Poll interval when WS is connected (30s)
```

In `loadDaemonConfig()`, add:

```typescript
wsPollInterval: parseDuration(process.env.ALOOK_DAEMON_WS_POLL_INTERVAL || "30s"),
```

- [ ] **Step 2: Integrate WS client into daemon.ts**

In `src/cli/daemon/daemon.ts`, add import:

```typescript
import { DaemonWsClient, type DaemonPushMessage } from "./ws-client.js";
```

After the `pollTimer` setup (around line 497), add WS client initialization:

```typescript
// WS Push Channel — primary communication, poll becomes fallback
const firstToken = workspaceStates[0]?.token;
let currentPollInterval = config.pollInterval;

const wsClient = firstToken
  ? new DaemonWsClient({
      serverURL: config.serverURL,
      daemonId: config.daemonId,
      machineToken: firstToken,
      onMessage: (msg: DaemonPushMessage) => handleWsPush(msg),
      onConnected: () => {
        log.info("WS connected — switching to low-frequency poll");
        updatePollInterval(config.wsPollInterval);
      },
      onDisconnected: () => {
        log.info("WS disconnected — reverting to high-frequency poll");
        updatePollInterval(config.pollInterval);
      },
    })
  : null;

wsClient?.connect();

function updatePollInterval(newInterval: number) {
  if (newInterval === currentPollInterval) return;
  currentPollInterval = newInterval;
  clearInterval(pollTimer);
  pollTimer = setInterval(pollCycle, currentPollInterval);
}

function handleWsPush(msg: DaemonPushMessage) {
  switch (msg.type) {
    case "daemon.tasks":
      for (const apiTask of msg.tasks) {
        const task = fromApiTask(apiTask);
        const ws = workspaceStates.find((w) => w.workspaceId === task.workspaceId);
        if (!ws) break;
        syncAgentId(task.agentId, ws.workspaceId);
        if (activeTasks.size >= config.maxConcurrentTasks) break;
        activeTasks.add(task.id);
        handleTask(client, config, runtimeIndex, task, ws.token, activeTasks)
          .catch((e) => { log.error("WS task error", e); activeTasks.delete(task.id); });
      }
      break;

    case "daemon.file_requests":
      for (const req of msg.requests) {
        const ws = workspaceStates[0];
        if (ws) {
          handleFileRequest(client, config, ws.workspaceId, req, ws.token)
            .catch((e) => log.debug("WS file request error", e));
        }
      }
      break;

    case "daemon.meetings":
      for (const m of msg.meetings) {
        const agentBaseDir = join(config.workspacesRoot, m.workspace_id, m.agent_id, "workdir");
        const timelineDir = join(agentBaseDir, ".context_timeline");
        const ws = workspaceStates.find((w) => w.workspaceId === m.workspace_id);
        if (!ws) continue;
        spawnMeetingRunner({
          meetingId: m.id,
          meetingUrl: m.meeting_url,
          participants: m.participants,
          workspaceId: m.workspace_id,
          callbackUrl: config.serverURL,
          authToken: ws.token,
          agentName: m.agent_name,
          agentId: m.agent_id,
          timelineDir,
          title: m.title,
        });
      }
      break;

    case "daemon.evict":
      evictWorkspace(msg.workspaceId);
      break;

    case "daemon.update":
      if (!isUpdating() && msg.version !== config.cliVersion) {
        handleCliUpdate(msg.version, () => requestRestart(), profile);
      }
      break;

    case "daemon.rescan":
      log.info("WS rescan requested — restarting daemon");
      requestRestart();
      break;

    case "daemon.kill": {
      const ws = workspaceStates[0];
      if (ws) {
        const killTask = fromApiTask({
          id: msg.taskId,
          agent_id: "",
          runtime_id: "",
          conversation_id: "",
          workspace_id: ws.workspaceId,
          prompt: "",
          status: "queued",
          priority: 0,
          dispatched_at: null,
          started_at: null,
          completed_at: null,
          result: null,
          error: null,
          created_at: new Date().toISOString(),
          type: "kill_task",
          context: { target_task_id: msg.targetTaskId },
          agent: null,
          sender: null,
        });
        activeTasks.add(killTask.id);
        handleTask(client, config, runtimeIndex, killTask, ws.token, activeTasks)
          .catch((e) => { log.error("WS kill task error", e); activeTasks.delete(killTask.id); });
      }
      break;
    }
  }
}
```

- [ ] **Step 3: Change pollTimer from const to let**

Change line 497 from:
```typescript
const pollTimer = setInterval(pollCycle, config.pollInterval);
```
to:
```typescript
let pollTimer = setInterval(pollCycle, config.pollInterval);
```

- [ ] **Step 4: Close WS client in shutdown**

In the `shutdown` function, add before clearing the poll timer:

```typescript
wsClient?.close();
```

- [ ] **Step 5: Move reconcilePendingCompletions to independent timer**

Remove `reconcilePendingCompletions` from inside `pollCycle` and create a separate interval:

```typescript
const reconcileTimer = setInterval(async () => {
  try {
    await reconcilePendingCompletions(config.workspacesRoot);
  } catch (e) {
    log.debug("reconciliation error", e);
  }
}, 60_000);
```

Clear it in `shutdown`:
```typescript
clearInterval(reconcileTimer);
```

- [ ] **Step 6: Build and verify**

Run: `cd src/cli && pnpm build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/cli/daemon/daemon.ts src/cli/daemon/config.ts
git commit -m "feat(cli): integrate WS push channel into daemon with poll fallback"
```

---

## Task 9: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Run all shared tests**

Run: `cd src/shared && pnpm test`
Expected: All PASS

- [ ] **Step 2: Run all web tests**

Run: `cd src/web && pnpm test`
Expected: All PASS

- [ ] **Step 3: Run all CLI tests**

Run: `cd src/cli && pnpm test`
Expected: All PASS

- [ ] **Step 4: Build all packages**

Run: `pnpm build`
Expected: All packages build successfully.

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address test/build issues from WS push integration"
```
