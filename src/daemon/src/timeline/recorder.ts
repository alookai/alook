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
import {
  appendOrMergeEntry,
  updateLatestEntryResult,
  readRecentEntries,
  readResumeControlState,
  updateResumeControlState,
  createTimelineEntry,
  createSystemEntry,
  resolveResumableSession,
  appendEntry,
  prepareTimelineDirectory,
} from "./timeline.js";
import type { Message } from "../server/contract.js";
import type { SystemEntryType } from "./types.js";
import type { ResumeSessionResolution } from "./timeline.js";

const MAX_AGENT_RESPONSES = 5;

function appendAgentResponse(entry: { agent_responses: string[] }, text: string): void {
  entry.agent_responses.push(text);
  if (entry.agent_responses.length > MAX_AGENT_RESPONSES) {
    entry.agent_responses.splice(0, entry.agent_responses.length - MAX_AGENT_RESPONSES);
  }
}

/** Manager/daemon-facing recorder interface (structural, avoids a cyclic import). */
export interface TimelineRecorderLike {
  /** CONTROL plane: remember the runtime session id; false means no state may advance. */
  setSession(agentId: string, sessionId: string): boolean;
  /** DATA plane: a successful inbox pull opens a new entry of what the agent saw. */
  appendEntryForAgent(agentId: string, messages: Message[]): void;
  /** CONTROL plane: append the agent's text output to its latest open entry. */
  appendResponseToLatest(agentId: string, text: string): void;
  /** Latest session id recorded for this agent (resume target), or null. */
  resumeSessionId(agentId: string, provider: string | null): string | null;
  /** Latest resume target or the durable barrier that supersedes older sources. */
  resolveResumeSession(agentId: string, provider: string | null): ResumeSessionResolution;
  /** Persist the consumed allowance; false means the caller must defer termination. */
  recordSessionStall(agentId: string, sessionId: string): boolean;
  /** Persist a clean replenishment; false leaves the allowance consumed. */
  clearSessionStall(agentId: string, sessionId: string): boolean;
  /**
   * Reset: append a `system` barrier row to the timeline (`reset_session` for
   * an owner reset, `nap` for an agent self-reset — default `reset_session`).
   * The resume walker treats reset/nap as full barriers and stall recovery as
   * an exact-session barrier — every superseded turn
   * becomes invisible to `resumeSessionId` — and the agent's own history read
   * (for recall) sees it in-line with turns. Also clears the in-memory session
   * cache so a racing `appendEntryForAgent` can't bake the stale id into a
   * fresh row. Returns false unless the authoritative control transition was
   * committed; the forensic row is appended only after that precondition.
   */
  forgetSession(agentId: string, barrierType?: SystemEntryType, forgottenSessionId?: string): boolean;
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
  const resolveForAgent = (agentId: string, provider: string | null): ResumeSessionResolution => {
    const dir = dirFor(agentId);
    const recent = resolveResumableSession(
      readRecentEntries(dir, { now: now() }),
      provider ?? undefined,
    );
    const control = readResumeControlState(dir);
    if (control.kind === "missing") return recent;
    if (control.kind === "invalid") {
      return {
        kind: "barrier",
        type: "reset_session",
        forgottenSessionId: null,
        fencedSessionId: null,
      };
    }
    const { attemptedSessionId, fencedSessionId, fullBarrier } = control.state;
    if (fullBarrier !== null) {
      return {
        kind: "barrier",
        type: fullBarrier,
        forgottenSessionId: null,
        fencedSessionId,
      };
    }
    if (recent.kind === "session") {
      return {
        kind: "session",
        sessionId: recent.sessionId,
        stalledSessionId: attemptedSessionId === recent.sessionId ? attemptedSessionId : null,
        fencedSessionId,
      };
    }
    if (recent.kind === "barrier") {
      if (recent.type !== "stall_recovery" || recent.forgottenSessionId === fencedSessionId) {
        return { ...recent, fencedSessionId };
      }
    }
    return { kind: "none", stalledSessionId: attemptedSessionId, fencedSessionId };
  };

  return {
    setSession(agentId, sessionId) {
      const dir = dirFor(agentId);
      if (!prepareTimelineDirectory(dir)) return false;
      const persisted = updateResumeControlState(dir, (state) => ({
        ...state,
        fullBarrier: null,
        attemptedSessionId: state.attemptedSessionId === sessionId ? state.attemptedSessionId : null,
      }));
      if (!persisted) return false;
      sessionByAgent.set(agentId, sessionId);
      return true;
    },
    appendEntryForAgent(agentId, messages) {
      if (messages.length === 0) return;
      const dir = dirFor(agentId);
      if (!prepareTimelineDirectory(dir)) return;
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
      if (!prepareTimelineDirectory(dir)) return;
      const result = updateLatestEntryResult(dir, (entry) => appendAgentResponse(entry, text), { now: now() });
      if (result === "updated" || result === "rejected") return;
      // No turn row exists yet (or the newest row is a system barrier) — open
      // a fresh, empty-messages turn row carrying the current session/provider
      // and stamp this response onto it. Happens whenever a `text` event
      // arrives before the fresh spawn's first inbox pull opened a row, e.g.
      // right after `reset_session` where the barrier is the file's latest
      // line and the rewake prompt makes the agent talk before pulling. A
      // later inbox pull with real messages appends its own row (since this
      // one already has a response, `appendOrMergeEntry` won't merge into it).
      const entry = createTimelineEntry({
        messages: [],
        sessionId: sessionByAgent.get(agentId) ?? null,
        provider: opts.providerFor?.(agentId) ?? null,
      });
      appendAgentResponse(entry, text);
      appendEntry(dir, entry, now());
    },
    resumeSessionId(agentId, provider) {
      const resolution = resolveForAgent(agentId, provider);
      return resolution.kind === "session" ? resolution.sessionId : null;
    },
    resolveResumeSession(agentId, provider) {
      return resolveForAgent(agentId, provider);
    },
    recordSessionStall(agentId, sessionId) {
      return appendStallMarker(agentId, "stall_recovery_attempt", sessionId);
    },
    clearSessionStall(agentId, sessionId) {
      return appendStallMarker(agentId, "stall_recovery_clear", sessionId);
    },
    forgetSession(agentId, barrierType = "reset_session", forgottenSessionId) {
      const dir = dirFor(agentId);
      // Persist the authoritative transition before clearing the in-memory
      // session map or appending its best-effort forensic row.
      // One `now()` sample so the system-row `time` and the day-file the row
      // is written into can't disagree on the boundary between two consecutive
      // clock reads.
      if (!prepareTimelineDirectory(dir)) return false;
      const stamp = now();
      let persisted = false;
      if (barrierType === "reset_session" || barrierType === "nap") {
        persisted = updateResumeControlState(dir, (state) => ({
          ...state,
          attemptedSessionId: null,
          fencedSessionId: null,
          fullBarrier: barrierType,
        }));
      } else if (barrierType === "stall_recovery") {
        persisted = updateResumeControlState(dir, (state) => ({
          ...state,
          attemptedSessionId:
            state.attemptedSessionId === forgottenSessionId ? null : state.attemptedSessionId,
          fencedSessionId: forgottenSessionId ?? null,
          fullBarrier: null,
        }));
      }
      if (!persisted) return false;
      sessionByAgent.delete(agentId);
      appendEntry(dir, createSystemEntry(barrierType, stamp.toISOString(), forgottenSessionId), stamp);
      return true;
    },
  };

  function appendStallMarker(agentId: string, type: SystemEntryType, sessionId: string): boolean {
    const dir = dirFor(agentId);
    if (!prepareTimelineDirectory(dir)) return false;
    const stamp = now();
    const persisted = updateResumeControlState(dir, (state) => ({
      ...state,
      attemptedSessionId: type === "stall_recovery_attempt" ? sessionId : null,
      fullBarrier: null,
    }));
    if (!persisted) return false;
    appendEntry(dir, createSystemEntry(type, stamp.toISOString(), sessionId), stamp);
    return true;
  }
}
