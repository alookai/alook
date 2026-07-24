/**
 * A timeline recorder backed by the JSONL module, injected into the daemon.
 *
 * Append-only, correlated by "this agent's latest entry" (no cross-layer task
 * id). Two planes write one entry:
 *   - DATA plane (the credential proxy's onInboxPullResponse): each inbox pull opens an entry
 *     via `appendEntryForAgent`, capturing the messages the agent saw + the
 *     session_id known so far + provider. A pull that arrives while the latest
 *     row is still unanswered (same session/provider, empty agent_responses)
 *     MERGES into it rather than splitting the turn (see appendOrMergeEntry) —
 *     which also removes the late-text misattribution race.
 *   - CONTROL plane (the manager): `setSession` records the runtime session id as
 *     soon as session_init fires (kept in memory and baked into the NEXT entry,
 *     since the pull that opens an entry happens after session_init);
 *     `appendResponseToLatest` accumulates the agent's text onto the latest row.
 *
 * Each agent's rows live in its own `<workdir>/.context_timeline`. Pure daily log
 * — records turns + answers resume lookups; never participates in steering.
 *
 * Final schema (gustavo): an entry is exactly `{session_id, messages,
 * agent_responses, provider}` — no task id / datetime / status / pid.
 */
import { mkdirSync } from "fs";
import {
  appendOrMergeEntry,
  updateLatestEntry,
  readRecentEntries,
  createTimelineEntry,
  createSystemEntry,
  findResumableSession,
  appendEntry,
} from "./timeline.js";
import type { Message } from "../server/contract.js";


/** Manager/daemon-facing recorder interface (structural, avoids a cyclic import). */
export interface TimelineRecorderLike {
  /** CONTROL plane: remember the runtime session id (baked into new entries). */
  setSession(agentId: string, sessionId: string): void;
  /** DATA plane: a successful inbox pull opens a new entry of what the agent saw. */
  appendEntryForAgent(agentId: string, messages: Message[]): void;
  /** CONTROL plane: append the agent's text output to its latest open entry. */
  appendResponseToLatest(agentId: string, text: string): void;
  /** Latest session id recorded for this agent (resume target), or null. */
  resumeSessionId(agentId: string, provider: string | null): string | null;
  /**
   * Owner-triggered reset: append a `system: { type: "reset_session" }` row
   * to the timeline. The resume walker treats that row as a barrier — every
   * turn at or before it becomes invisible to `resumeSessionId` — and the
   * agent's own history read (for recall) sees the reset in-line with turns.
   * Also clears the in-memory session cache so a racing `appendEntryForAgent`
   * can't bake the stale id into a fresh row.
   */
  forgetSession(agentId: string): void;
}

export interface TimelineRecorderOptions {
  /** Map an agentId to its timeline directory (e.g. `<workdir>/.context_timeline`). */
  timelineDirFor: (agentId: string) => string;
  /** Provider stamped on new entries (resume can be constrained to it). */
  providerFor?: (agentId: string) => string | null;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export function createTimelineRecorder(opts: TimelineRecorderOptions): TimelineRecorderLike {
  const now = opts.now ?? (() => new Date());
  const dirFor = (agentId: string) => opts.timelineDirFor(agentId);
  // session_init (control plane) lands before the agent's first pull (data plane)
  // opens an entry, so hold the latest session id here and bake it into new rows.
  const sessionByAgent = new Map<string, string>();

  return {
    setSession(agentId, sessionId) {
      sessionByAgent.set(agentId, sessionId);
    },
    appendEntryForAgent(agentId, messages) {
      const dir = dirFor(agentId);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort; appendEntry no-ops on a missing dir */
      }
      appendOrMergeEntry(
        dir,
        createTimelineEntry({
          messages,
          sessionId: sessionByAgent.get(agentId) ?? null,
          provider: opts.providerFor?.(agentId) ?? null,
        }),
        now(),
      );
    },
    appendResponseToLatest(agentId, text) {
      const dir = dirFor(agentId);
      const updated = updateLatestEntry(dir, (e) => e.agent_responses.push(text), { now: now() });
      if (updated) return;
      // No turn row exists yet (or the newest row is a system barrier) — open
      // a fresh, empty-messages turn row carrying the current session/provider
      // and stamp this response onto it. Happens whenever a `text` event
      // arrives before the fresh spawn's first inbox pull opened a row, e.g.
      // right after `reset_session` where the barrier is the file's latest
      // line and the rewake prompt makes the agent talk before pulling. A
      // later inbox pull with real messages appends its own row (since this
      // one already has a response, `appendOrMergeEntry` won't merge into it).
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort */
      }
      const entry = createTimelineEntry({
        messages: [],
        sessionId: sessionByAgent.get(agentId) ?? null,
        provider: opts.providerFor?.(agentId) ?? null,
      });
      entry.agent_responses.push(text);
      appendEntry(dir, entry, now());
    },
    resumeSessionId(agentId, provider) {
      const rows = readRecentEntries(dirFor(agentId), { now: now() });
      return findResumableSession(rows, provider ?? undefined);
    },
    forgetSession(agentId) {
      const dir = dirFor(agentId);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort — appendEntry handles a missing dir by returning false */
      }
      // Kill happens BEFORE this call (see `AgentProcessManager.resetSession`),
      // so no race — clear the in-memory session map and append the barrier.
      // One `now()` sample so the system-row `time` and the day-file the row
      // is written into can't disagree on the boundary between two consecutive
      // clock reads.
      sessionByAgent.delete(agentId);
      const stamp = now();
      appendEntry(dir, createSystemEntry("reset_session", stamp.toISOString()), stamp);
    },
  };
}
