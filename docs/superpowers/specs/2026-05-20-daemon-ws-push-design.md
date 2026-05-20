# Daemon WebSocket Push Channel

**Date:** 2026-05-20  
**Status:** Draft  
**Author:** Jarvis

## Problem

The daemon currently relies on HTTP polling every 3 seconds to receive tasks, file requests, meetings, CLI updates, and eviction signals from the server. This introduces 0-3s latency for every event and generates unnecessary HTTP requests during idle periods.

## Solution

Add a WebSocket connection between the daemon and the existing WS DO (Durable Object). Events are pushed to the daemon in real-time the moment they occur. HTTP poll is retained at 30s as a fallback for missed events during WS reconnection windows.

## Architecture

```
                     ┌──────────────────┐
                     │   WS DO Worker   │
                     │  (alook-ws-do)   │
                     └───┬──────────┬───┘
                         │          │
          user:{userId}  │          │  daemon:{daemonId}
                         │          │
                   ┌─────┴──┐  ┌────┴─────┐
                   │Frontend │  │  Daemon   │
                   └─────────┘  └────┬─────┘
                                     │
                               (WS down → fallback)
                                     │
                               HTTP Poll (30s)
```

Web Server is the business center. When events occur, it broadcasts to daemon via Service Binding → WS DO.

## WS DO Changes

### Connection Types

```typescript
type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; workspaceIds: string[]; authenticated: boolean }
```

### Authentication

Daemon sends after connection:
```json
{ "type": "auth", "machineToken": "<any_valid_workspace_machine_token>", "daemonId": "<daemon_id>" }
```

A daemon may serve multiple workspaces but only has one WS connection. It authenticates using any one of its valid workspace machine tokens. DO validates the token against D1 (confirms the daemon exists and the token is associated with a workspace that references this daemon). On success:

```json
{ "type": "auth.ok" }
```

On failure: close with code 1008.

The `daemonId` is the routing key for push messages. The specific workspace token used for auth does not limit which workspaces can push to this daemon.

### Broadcast Routing

New route in `ws-do/src/index.ts`:

```
POST /broadcast/daemon/{daemonId}
```

DO instance keyed by `daemon:{daemonId}`. One daemon = one DO instance = one WS connection.

### Connection Lifecycle

- `webSocketClose`: When a daemon connection closes, the DO notifies the server (HTTP POST or KV write) to mark the daemon offline.
- Auto-response: `ping` → `pong` (same as user connections).

## Daemon Push Message Protocol

```typescript
type DaemonPushMessage =
  | { type: "daemon.tasks"; tasks: FullTaskPayload[] }
  | { type: "daemon.file_requests"; requests: FileRequestItem[] }
  | { type: "daemon.meetings"; meetings: PollMeetingItem[] }
  | { type: "daemon.evict"; workspaceId: string }
  | { type: "daemon.update"; version: string }
  | { type: "daemon.rescan" }
  | { type: "daemon.kill"; taskId: string; targetTaskId: string }
```

Each message type corresponds to what was previously bundled in the poll response. The difference: they are pushed immediately when the event occurs, not batched on a 3s interval.

## Server-Side Changes

### TaskPayloadBuilder (new service)

Extract the ~150 lines of data assembly logic from `poll/route.ts` into a reusable service:

```typescript
// src/web/src/lib/services/task-payload-builder.ts
class TaskPayloadBuilder {
  constructor(private db: Database, private env: Env) {}

  async buildFullPayloads(
    tasks: Task[],
    workspaceId: string,
  ): Promise<FullTaskPayload[]>
}
```

This builder is shared by:
1. The poll route (fallback path)
2. Push logic at task enqueue time

### Push Trigger Points

| Event | Where it happens | Push message |
|-------|-----------------|--------------|
| Task enqueued | `TaskService.enqueueTask()` | `daemon.tasks` |
| Kill task created | `TaskService.enqueueTask()` (type=kill_task) | `daemon.kill` |
| File browse request | `agents/[id]/workspace/browse/route.ts` | `daemon.file_requests` |
| Meeting scheduled (within 5min window) | Calendar promote / meeting creation | `daemon.meetings` |
| Workspace eviction | Admin action / machine deletion | `daemon.evict` |
| CLI update requested | Machine `pendingUpdateVersion` set | `daemon.update` |
| Rescan requested | Machine `pendingRescan` set | `daemon.rescan` |

### Daemon ID Resolution

Task → `runtimeId` → `machines` table → `daemonId`. This mapping already exists. At push time:

```typescript
const daemonId = await getDaemonIdForRuntime(runtimeId);
if (daemonId) {
  broadcastToDaemon(daemonId, message);
}
```

If no daemon is connected (WS not established), the push is a no-op. The task remains in the queue and will be picked up by the fallback poll.

### broadcastToDaemon (new function)

```typescript
// src/web/src/lib/broadcast.ts
export function broadcastToDaemon(daemonId: string, message: DaemonPushMessage): Promise<void> {
  return sendBroadcast(
    `/broadcast/daemon/${daemonId}`,
    JSON.stringify(message),
    { daemonId, type: message.type },
  );
}
```

## Daemon-Side Changes

### New Module: `src/cli/daemon/ws-client.ts`

Responsibilities:
- Establish WS connection to `wss://alook.ai/api/ws/daemon?daemonId=xxx`
- Authenticate with machine token
- Handle incoming push messages → dispatch to existing handlers
- Reconnect with exponential backoff (1s → 30s max, ±500ms jitter)
- Periodic ping (25s) for connection liveness detection
- Liveness check: if no message received in 30s, close and reconnect

### Message Dispatch

```typescript
function handleWsMessage(msg: DaemonPushMessage) {
  switch (msg.type) {
    case "daemon.tasks":
      for (const task of msg.tasks) {
        handleTask(client, config, runtimeIndex, task, token, activeTasks);
      }
      break;
    case "daemon.file_requests":
      for (const req of msg.requests) {
        handleFileRequest(client, config, workspaceId, req, token);
      }
      break;
    case "daemon.meetings":
      for (const m of msg.meetings) {
        spawnMeetingRunner(m);
      }
      break;
    case "daemon.evict":
      evictWorkspace(msg.workspaceId);
      break;
    case "daemon.update":
      handleCliUpdate(msg.version, requestRestart, profile);
      break;
    case "daemon.rescan":
      requestRestart();
      break;
    case "daemon.kill":
      handleKillTask(msg.targetTaskId);
      break;
  }
}
```

### Poll Behavior Change

```typescript
const WS_CONNECTED_POLL_INTERVAL = 30_000;  // 30s when WS is up
const WS_DISCONNECTED_POLL_INTERVAL = 3_000; // 3s fallback (current behavior)

// Dynamic interval based on WS connection state
function getCurrentPollInterval(): number {
  return wsClient.isConnected()
    ? WS_CONNECTED_POLL_INTERVAL
    : WS_DISCONNECTED_POLL_INTERVAL;
}
```

Poll continues to serve as:
1. Fallback for events missed during WS reconnection gaps
2. Heartbeat (KV + D1 liveness writes still happen on poll)
3. Catch-all sync (stale calendar events, sweep, reconcile)

### Startup Sequence

```
daemon start
  → Load config
  → Attempt WS connection (non-blocking)
  → Start poll timer (3s initially)
  → WS connects + authenticates → switch poll to 30s
  → WS disconnects → switch poll back to 3s, reconnect WS in background
```

## Heartbeat & Online Status

With WS as primary channel:
- **WS connected** = daemon online. DO knows immediately.
- **WS disconnects** → DO `webSocketClose` fires → server marks daemon offline (KV delete or write status=offline).
- **Fallback poll** still writes KV heartbeat as safety net (covers the case where WS DO fails to notify).

The `runtime.status` broadcast to frontend (currently triggered on each poll) will now be triggered:
- On WS daemon auth success → broadcast `runtime.status: online`
- On WS daemon close → broadcast `runtime.status: offline`
- On fallback poll (30s) → broadcast `runtime.status: online` (as before, less frequent)

## Local Development

- WS DO runs at `localhost:8789` (existing setup)
- Daemon connects to `ws://localhost:8789/?daemonId=xxx`
- `custom-worker.ts` intercepts `/api/ws/daemon` upgrade → forwards to WS DO Worker (same pattern as user WS)
- Broadcast fallback uses `DEV_WS_DO_URL` (existing mechanism)

## Backward Compatibility

- **Old daemon** (no WS client): continues using 3s poll. Server push is a no-op (no WS connection exists for that daemon). Tasks remain in queue for poll to claim.
- **New daemon, WS fails**: automatically falls back to 3s poll. Identical behavior to current system.
- **Server deploys before daemon update**: no impact. Push calls find no daemon WS connection, tasks stay in queue.

## Capacity Management

Current poll sends `remaining` (max_tasks - active count) so server only returns tasks the daemon can handle. With WS push:

- Server still respects capacity. Before pushing `daemon.tasks`, check daemon's reported capacity.
- Daemon sends capacity updates over WS: `{ type: "capacity", remaining: N }` whenever active task count changes.
- If server doesn't know capacity (e.g., just connected), push tasks optimistically — daemon can reject/queue locally, or server can query capacity first via WS.

Alternative (simpler): don't track capacity in push path. Let tasks enqueue. The daemon's `handleTask` already checks capacity and can nack or defer. Fallback poll still handles overflow with `max_tasks` param.

**Decision:** Start with the simpler approach — push all tasks, daemon handles overflow locally. Add capacity tracking later if needed.

## reconcilePendingCompletions

This is a local disk cleanup operation unrelated to server push. Move it to its own independent timer (60s interval) that runs regardless of WS/poll state. This was already identified as an optimization in the initial analysis.

## Migration Plan

1. Deploy WS DO changes (new daemon connection type + broadcast route)
2. Deploy Web Server changes (TaskPayloadBuilder + broadcastToDaemon at trigger points)
3. Release daemon with WS client (new CLI version)
4. Old daemons unaffected, new daemons benefit immediately

Each step is independently deployable and backward compatible.
