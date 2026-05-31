/**
 * Dedup gate for the fast-path chat load (TODO 6 / stuck-skeleton regression fix).
 *
 * The chat load effect re-fires on channel-dep changes (activeChannel /
 * channelLoading). For a known conversation (fast path) those deps are
 * irrelevant, so a re-fire with the same identity should be skipped to avoid a
 * skeleton flash + re-fetch. BUT skipping must never strand the UI on the
 * loading skeleton: if the previous run for that identity was cancelled before
 * it finished, the re-fire is a *recovery* run and MUST proceed.
 *
 * The invariant: a fast-load key is recorded as "completed" only AFTER its
 * load() resolves (not when it starts). So:
 *   - same key, prior run completed  → skip (steady-state channel change)
 *   - same key, prior run cancelled  → do NOT skip (recovery; clears skeleton)
 *
 * This module is the pure decision logic, extracted so the lifecycle can be
 * unit-tested without rendering the component (the web test env is node-only,
 * no jsdom/RTL).
 */

export interface FastLoadGateState {
  /** The fast-load key whose load() has fully COMPLETED, or null. */
  completedKey: string | null;
}

export function createFastLoadGateState(): FastLoadGateState {
  return { completedKey: null };
}

/**
 * Build the fast-path key for a load identity, or null for the slow path
 * (no targetConvId). Channel is intentionally excluded — channel changes must
 * not change the key.
 */
export function fastLoadKey(opts: {
  workspaceId: string;
  agentId: string;
  targetConvId: string | null | undefined;
  scrollToTaskId: string | null | undefined;
}): string | null {
  if (!opts.targetConvId) return null;
  return `${opts.workspaceId}::${opts.agentId}::${opts.targetConvId}::${opts.scrollToTaskId ?? ""}`;
}

/**
 * Decide whether this effect run should skip starting a load. Returns true only
 * when a load for the same fast key has already completed. Mutates state to
 * clear the completed marker when a run is about to start (so an in-flight run
 * leaves no "done" marker if it gets cancelled).
 */
export function shouldSkipFastLoad(key: string | null, state: FastLoadGateState): boolean {
  if (key && state.completedKey === key) return true;
  // A new / recovery run is starting — until it finishes, nothing is "completed".
  state.completedKey = null;
  return false;
}

/**
 * Record that a load fully completed (call from the finally block when the run
 * was NOT superseded). A cancelled run must not call this.
 */
export function markFastLoadCompleted(key: string | null, state: FastLoadGateState): void {
  if (key) state.completedKey = key;
}
