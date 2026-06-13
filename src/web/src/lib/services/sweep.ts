import type { Database } from "@alook/shared";
import { queries } from "@alook/shared";
import { TaskService } from "./task";
import { throttled, invalidate, cacheKeys } from "@/lib/cache";

const SWEEP_INTERVAL_S = 30;

/** @internal test-only */
export function _resetSweepThrottle() {}

/**
 * Unified workspace housekeeping. Any code path that wants to ensure
 * stale state is cleaned up just calls this one function.
 * Rate-limited to once per 30s per workspace via KV (timestamp-based).
 */
export async function sweepStaleState(db: Database, workspaceId: string) {
  const lockKey = `sweep:${workspaceId}`;
  let shouldRun = false;
  try {
    shouldRun = await throttled(lockKey, SWEEP_INTERVAL_S, async () => {});
  } catch {
    shouldRun = true;
  }
  if (!shouldRun) return;

  // 1. Fail tasks stuck in "dispatched" for >20s (daemon crashed between claim and start)
  const staleDispatched = await queries.task.failStaleDispatchedTasks(db, workspaceId);

  // 1b. Fail kill_tasks stuck for >30s (daemon offline or crashed after claim)
  await queries.task.failStaleKillTasks(db, workspaceId);

  // 2. Fail tasks stuck in "running" with no message activity for >1h
  const staleRunning = await queries.task.failStaleRunningTasks(db, workspaceId);

  // 3. Reconcile agent status for all affected agents
  const allStale = [...staleDispatched, ...staleRunning];
  if (allStale.length > 0) {
    const taskService = new TaskService(db);
    const seenAgents = new Set<string>();
    for (const r of allStale) {
      const key = `${r.agentId}:${r.workspaceId}`;
      if (seenAgents.has(key)) continue;
      seenAgents.add(key);
      await taskService.reconcileAgentStatus(r.agentId, r.workspaceId);
    }

    // Invalidate caches that sweep modified
    const dateStr = new Date().toISOString().slice(0, 10);
    await Promise.all([
      invalidate(cacheKeys.overviewTaskStats(workspaceId, dateStr)),
      invalidate(cacheKeys.activeTaskCounts(workspaceId)),
    ]).catch(() => {});
  }
}
