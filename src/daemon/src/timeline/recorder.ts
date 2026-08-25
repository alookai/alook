/**
 * A timeline recorder backed by the JSONL module, injected into the daemon.
 *
 * Inbox observations and complete assistant messages are correlated by an
 * in-memory exact root-turn owner. A pull captures that owner at request start;
 * the recorder opens or updates one row and retains an opaque process-local
 * handle. Finalization can update only that captured row. There is deliberately
 * no "latest row" fallback.
 *
 * Each agent's rows live in its own `<workdir>/.context_timeline`. Pure daily log
 * — records turns + answers resume lookups; never participates in steering.
 *
 * Final schema (gustavo): an entry is exactly `{session_id, messages,
 * agent_responses, provider}` — no task id / datetime / status / pid.
 */
import {
  readRecentEntries,
  readResumeControlState,
  updateResumeControlState,
  createTimelineEntry,
  createSystemEntry,
  resolveResumableSession,
  appendTrackedEntry,
  updateTrackedEntry,
  refreshTimelineEntryHandle,
  filenameForDate,
  TIMELINE_MAX_BYTES,
  prepareTimelineDirectory,
} from "./timeline.js";
import type {
  ResumeSessionResolution,
  TimelineEntryHandle,
  TimelineFileRewrite,
  TimelineTrackedWriteResult,
} from "./timeline.js";
import type { Message } from "../server/contract.js";
import type { ContextTimelineEntry, SystemEntryType } from "./types.js";

const MAX_AGENT_RESPONSES = 5;
const MAX_AGENT_RESPONSE_BYTES = 65_536;
const MAX_PENDING_COMMITS_PER_AGENT = 8;
const PENDING_COMMIT_TTL_MS = 15 * 60_000;
const TRUNCATION_MARKER = "\n… [truncated]";

export interface TimelineTurnOwner {
  sessionInstanceId: string;
  rootTurnId: string;
  barrierGeneration: number;
}

interface TurnRecorderState {
  owner: TimelineTurnOwner;
  provider: string | null;
  backendSessionId: string | null;
  responses: string[];
  handle?: TimelineEntryHandle;
  rowFenced: boolean;
  finalized: boolean;
  completedAtMs?: number;
  pendingSinceMs?: number;
  pendingMode?: "handle" | "fallback";
}

function turnKey(agentId: string, owner: TimelineTurnOwner): string {
  return `${agentId}\0${owner.sessionInstanceId}\0${owner.rootTurnId}\0${owner.barrierGeneration}`;
}

function sameOwner(left: TimelineTurnOwner, right: TimelineTurnOwner): boolean {
  return left.sessionInstanceId === right.sessionInstanceId
    && left.rootTurnId === right.rootTurnId
    && left.barrierGeneration === right.barrierGeneration;
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let end = mid;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    if (Buffer.byteLength(text.slice(0, end), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return text.slice(0, end);
}

function boundedResponse(text: string, alreadyTruncated: boolean): string {
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const needsTruncation = alreadyTruncated || Buffer.byteLength(text, "utf8") > MAX_AGENT_RESPONSE_BYTES;
  if (!needsTruncation) return text;
  return utf8Prefix(text, MAX_AGENT_RESPONSE_BYTES - markerBytes) + TRUNCATION_MARKER;
}

function serializedTimelineBytes(entry: ContextTimelineEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
}

function fitResponsesToRow(entry: ContextTimelineEntry, responses: readonly string[]): string[] | null {
  let fitted = [...entry.agent_responses];
  for (const response of responses) {
    fitted = [...fitted, response].slice(-MAX_AGENT_RESPONSES);
    if (serializedTimelineBytes({ ...entry, agent_responses: fitted }) <= TIMELINE_MAX_BYTES) continue;
    const truncationBase = response.endsWith(TRUNCATION_MARKER)
      ? response.slice(0, -TRUNCATION_MARKER.length)
      : response;
    let low = 0;
    let high = truncationBase.length;
    let replacement: string | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      let end = mid;
      const code = truncationBase.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      const candidateResponse = truncationBase.slice(0, end) + TRUNCATION_MARKER;
      const candidate = [...fitted.slice(0, -1), candidateResponse];
      if (serializedTimelineBytes({ ...entry, agent_responses: candidate }) <= TIMELINE_MAX_BYTES) {
        replacement = candidateResponse;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (replacement === null) return null;
    fitted[fitted.length - 1] = replacement;
  }
  return fitted;
}

/** Manager/daemon-facing recorder interface (structural, avoids a cyclic import). */
export interface TimelineRecorderLike {
  /** Current in-memory barrier epoch captured by pull-start owner snapshots. */
  barrierGeneration(agentId: string): number;
  /** Begin one exact root turn before any completed semantic output can arrive. */
  beginTurn(agentId: string, owner: TimelineTurnOwner): void;
  /** Record a pull against its immutable request-start owner, or as explicitly ownerless. */
  recordInboxPull(agentId: string, owner: TimelineTurnOwner | null, messages: Message[]): void;
  /** Retain one completed assistant message for its exact live turn. */
  recordAssistantMessage(agentId: string, owner: TimelineTurnOwner, text: string, truncated?: boolean): void;
  /** Finalize exactly once; fallback is allowed only for the still-active unfenced owner. */
  finalizeTurn(agentId: string, owner: TimelineTurnOwner): void;
  /** Fence ownership for model/session replacement without writing a durable reset row. */
  fenceSession(agentId: string): void;
  /** CONTROL plane: persist and remember the runtime session id; false means no state may advance. */
  setSession(agentId: string, sessionId: string, sessionInstanceId?: string): boolean;
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
   * cache so a racing pull cannot bake the stale id into a fresh row.
   * Returns false unless the authoritative control transition was committed;
   * the forensic row is appended only after that precondition.
   */
  forgetSession(
    agentId: string,
    barrierType?: SystemEntryType,
    forgottenSessionId?: string,
    pendingIdleResetEvent?: { eventId: string; occurredAt: string },
  ): boolean;
  /** Durable idle-reset completions which still need a server receipt. */
  pendingIdleResetEvents(
    agentId: string,
  ): ReadonlyArray<{ eventId: string; occurredAt: string }>;
  /** Clear one durable completion only after its server receipt arrives. */
  acknowledgeIdleResetEvent(agentId: string, eventId: string): boolean;
}

export interface TimelineRecorderOptions {
  /** Map an agentId to its timeline directory (e.g. `<workdir>/.context_timeline`). */
  timelineDirFor: (agentId: string) => string;
  /** Provider stamped on new entries (resume can be constrained to it). */
  providerFor?: (agentId: string) => string | null;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Bounded fail-closed diagnostics; never receives response/reasoning content. */
  onDiagnostic?: (event: { agentId: string; code: string; reason?: string }) => void;
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

  const sessionByEpoch = new Map<string, string>();
  const barrierByAgent = new Map<string, number>();
  const turnsByAgent = new Map<string, Map<string, TurnRecorderState>>();
  const activeTurnByAgent = new Map<string, string>();
  const epochKey = (agentId: string, sessionInstanceId: string) => `${agentId}\0${sessionInstanceId}`;
  const currentBarrier = (agentId: string) => barrierByAgent.get(agentId) ?? 0;
  const statesFor = (agentId: string): Map<string, TurnRecorderState> => {
    let states = turnsByAgent.get(agentId);
    if (!states) {
      states = new Map();
      turnsByAgent.set(agentId, states);
    }
    return states;
  };
  const diagnostic = (agentId: string, code: string, reason?: string): void => {
    try { opts.onDiagnostic?.({ agentId, code, ...(reason ? { reason } : {}) }); } catch { /* observer only */ }
  };
  const applyRewrite = (agentId: string, rewrite: TimelineFileRewrite): void => {
    for (const state of statesFor(agentId).values()) {
      if (!state.handle) continue;
      const refreshed = refreshTimelineEntryHandle(state.handle, rewrite);
      if (refreshed) {
        state.handle = refreshed;
      } else if (state.handle.filename === rewrite.filename) {
        state.handle = undefined;
        state.rowFenced = true;
        diagnostic(agentId, "timeline_handle_fenced", "rewrite_remap");
      }
    }
  };
  const handleTrackedResult = (
    agentId: string,
    state: TurnRecorderState | null,
    result: TimelineTrackedWriteResult,
  ): "written" | "retryable" | "terminal" => {
    if (result.status === "written") {
      applyRewrite(agentId, result.rewrite);
      if (state && result.handle) {
        state.handle = result.handle;
        state.rowFenced = false;
      }
      return "written";
    }
    if (result.reason === "lock" || result.reason === "write") return "retryable";
    if (state && result.reason !== "oversized") state.rowFenced = true;
    diagnostic(agentId, "timeline_exact_write_rejected", result.reason);
    return "terminal";
  };
  const tryCommit = (agentId: string, state: TurnRecorderState): "written" | "retryable" | "terminal" => {
    if (state.responses.length === 0) return "written";
    const dir = dirFor(agentId);
    if (!prepareTimelineDirectory(dir)) {
      diagnostic(agentId, "timeline_directory_unavailable");
      return "terminal";
    }
    if (state.handle) {
      const result = updateTrackedEntry(dir, state.handle, (entry) => {
        const fitted = fitResponsesToRow(entry, state.responses);
        return { ...entry, agent_responses: fitted ?? [...entry.agent_responses, ...state.responses] };
      });
      return handleTrackedResult(agentId, state, result);
    }
    if (state.rowFenced || state.pendingMode === "handle") return "terminal";
    if (state.owner.barrierGeneration !== currentBarrier(agentId)) return "terminal";
    const entry = createTimelineEntry({
      messages: [],
      sessionId: state.backendSessionId,
      provider: state.provider,
    });
    const fitted = fitResponsesToRow(entry, state.responses);
    if (!fitted) {
      diagnostic(agentId, "timeline_response_did_not_fit", "oversized");
      return "terminal";
    }
    entry.agent_responses = fitted;
    const result = appendTrackedEntry(dir, entry, now());
    return handleTrackedResult(agentId, state, result);
  };
  const deleteState = (agentId: string, key: string): void => {
    const states = statesFor(agentId);
    states.delete(key);
    if (activeTurnByAgent.get(agentId) === key) activeTurnByAgent.delete(agentId);
    if (states.size === 0) turnsByAgent.delete(agentId);
  };
  const retryPending = (agentId: string): void => {
    const states = turnsByAgent.get(agentId);
    if (!states) return;
    const nowMs = now().getTime();
    for (const [key, state] of [...states]) {
      if (
        state.finalized
        && state.pendingSinceMs === undefined
        && state.completedAtMs !== undefined
        && nowMs - state.completedAtMs >= PENDING_COMMIT_TTL_MS
      ) {
        deleteState(agentId, key);
        continue;
      }
      if (!state.finalized || state.pendingSinceMs === undefined) continue;
      if (nowMs - state.pendingSinceMs >= PENDING_COMMIT_TTL_MS) {
        diagnostic(agentId, "timeline_pending_commit_expired");
        deleteState(agentId, key);
        continue;
      }
      const result = tryCommit(agentId, state);
      if (result === "written") {
        state.responses = [];
        state.pendingSinceMs = undefined;
        state.pendingMode = undefined;
        state.completedAtMs = nowMs;
      } else if (result === "terminal") {
        deleteState(agentId, key);
      }
    }
    const completed = [...states.entries()]
      .filter(([, state]) => state.finalized && state.pendingSinceMs === undefined)
      .sort((left, right) => (left[1].completedAtMs ?? 0) - (right[1].completedAtMs ?? 0));
    while (completed.length > MAX_PENDING_COMMITS_PER_AGENT) {
      const oldest = completed.shift();
      if (oldest) deleteState(agentId, oldest[0]);
    }
  };
  const retainPending = (agentId: string, key: string, state: TurnRecorderState): void => {
    const states = statesFor(agentId);
    const pending = [...states.values()].filter((candidate) => candidate.finalized && candidate.pendingSinceMs !== undefined);
    if (pending.length >= MAX_PENDING_COMMITS_PER_AGENT) {
      diagnostic(agentId, "timeline_pending_commit_overflow");
      deleteState(agentId, key);
      return;
    }
    state.pendingSinceMs ??= now().getTime();
    state.pendingMode = state.handle ? "handle" : "fallback";
  };
  const appendOwnerless = (agentId: string, messages: Message[]): void => {
    if (messages.length === 0) return;
    const dir = dirFor(agentId);
    if (!prepareTimelineDirectory(dir)) return;
    const result = appendTrackedEntry(
      dir,
      createTimelineEntry({
        messages,
        sessionId: sessionByAgent.get(agentId) ?? null,
        provider: opts.providerFor?.(agentId) ?? null,
      }),
      now(),
    );
    handleTrackedResult(agentId, null, result);
  };

  return {
    barrierGeneration(agentId) {
      return currentBarrier(agentId);
    },
    beginTurn(agentId, owner) {
      retryPending(agentId);
      const states = statesFor(agentId);
      if (owner.barrierGeneration !== currentBarrier(agentId)) {
        diagnostic(agentId, "timeline_turn_begin_fenced", "barrier_generation");
        return;
      }
      const key = turnKey(agentId, owner);
      if (!states.has(key)) {
        states.set(key, {
          owner: { ...owner },
          provider: opts.providerFor?.(agentId) ?? null,
          backendSessionId: sessionByEpoch.get(epochKey(agentId, owner.sessionInstanceId))
            ?? sessionByAgent.get(agentId)
            ?? null,
          responses: [],
          rowFenced: false,
          finalized: false,
        });
      }
      activeTurnByAgent.set(agentId, key);
    },
    recordInboxPull(agentId, owner, messages) {
      retryPending(agentId);
      if (messages.length === 0) return;
      if (!owner) {
        appendOwnerless(agentId, messages);
        return;
      }
      const key = turnKey(agentId, owner);
      const state = turnsByAgent.get(agentId)?.get(key);
      if (!state || state.rowFenced || !sameOwner(state.owner, owner)) {
        appendOwnerless(agentId, messages);
        return;
      }
      const dir = dirFor(agentId);
      if (!prepareTimelineDirectory(dir)) return;
      const stamp = now();
      let result: TimelineTrackedWriteResult;
      if (
        state.handle
        && (
          state.handle.filename === filenameForDate(stamp)
          || state.owner.barrierGeneration !== currentBarrier(agentId)
        )
      ) {
        result = updateTrackedEntry(dir, state.handle, (entry) => ({
          ...entry,
          messages: [...entry.messages, ...messages],
          session_id: state.backendSessionId,
          provider: state.provider,
        }));
      } else if (state.owner.barrierGeneration === currentBarrier(agentId)) {
        result = appendTrackedEntry(
          dir,
          createTimelineEntry({
            messages,
            sessionId: state.backendSessionId,
            provider: state.provider,
          }),
          stamp,
        );
      } else {
        appendOwnerless(agentId, messages);
        return;
      }
      handleTrackedResult(agentId, state, result);
    },
    recordAssistantMessage(agentId, owner, text, truncated = false) {
      retryPending(agentId);
      const key = turnKey(agentId, owner);
      const state = turnsByAgent.get(agentId)?.get(key);
      if (
        !state
        || state.finalized
        || state.owner.barrierGeneration !== currentBarrier(agentId)
        || !sameOwner(state.owner, owner)
      ) {
        diagnostic(agentId, "timeline_completed_message_rejected", "stale_owner");
        return;
      }
      state.responses.push(boundedResponse(text, truncated));
      if (state.responses.length > MAX_AGENT_RESPONSES) {
        state.responses.splice(0, state.responses.length - MAX_AGENT_RESPONSES);
      }
    },
    finalizeTurn(agentId, owner) {
      retryPending(agentId);
      const key = turnKey(agentId, owner);
      const state = turnsByAgent.get(agentId)?.get(key);
      if (!state || state.finalized || !sameOwner(state.owner, owner)) return;
      const fallbackAuthorized = activeTurnByAgent.get(agentId) === key
        && owner.barrierGeneration === currentBarrier(agentId);
      state.finalized = true;
      activeTurnByAgent.delete(agentId);
      if (state.responses.length === 0) {
        state.completedAtMs = now().getTime();
        return;
      }
      if (!state.handle && !fallbackAuthorized) {
        diagnostic(agentId, "timeline_fallback_rejected", "fenced_owner");
        deleteState(agentId, key);
        return;
      }
      const result = tryCommit(agentId, state);
      if (result === "written") {
        state.responses = [];
        state.completedAtMs = now().getTime();
      } else if (result === "terminal") {
        deleteState(agentId, key);
      } else {
        retainPending(agentId, key, state);
      }
    },
    fenceSession(agentId) {
      retryPending(agentId);
      barrierByAgent.set(agentId, currentBarrier(agentId) + 1);
      activeTurnByAgent.delete(agentId);
      const states = turnsByAgent.get(agentId);
      if (!states) return;
      for (const [key, state] of [...states]) {
        if (!state.handle) {
          diagnostic(agentId, "timeline_fallback_rejected", "session_fence");
          deleteState(agentId, key);
        }
      }
    },
    setSession(agentId, sessionId, sessionInstanceId) {
      retryPending(agentId);
      const dir = dirFor(agentId);
      if (!prepareTimelineDirectory(dir)) return false;
      const persisted = updateResumeControlState(dir, (state) => ({
        ...state,
        fullBarrier: null,
        attemptedSessionId: state.attemptedSessionId === sessionId ? state.attemptedSessionId : null,
      }));
      if (!persisted) return false;
      sessionByAgent.set(agentId, sessionId);
      if (sessionInstanceId) {
        sessionByEpoch.set(epochKey(agentId, sessionInstanceId), sessionId);
        for (const state of statesFor(agentId).values()) {
          if (state.owner.sessionInstanceId === sessionInstanceId) state.backendSessionId = sessionId;
        }
      }
      return true;
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
    forgetSession(agentId, barrierType = "reset_session", forgottenSessionId, pendingIdleResetEvent) {
      retryPending(agentId);
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
          pendingIdleResetEvents:
            pendingIdleResetEvent
              && !state.pendingIdleResetEvents.some(({ eventId }) => eventId === pendingIdleResetEvent.eventId)
              ? [...state.pendingIdleResetEvents, pendingIdleResetEvent]
              : state.pendingIdleResetEvents,
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
      for (const key of [...sessionByEpoch.keys()]) {
        if (key.startsWith(`${agentId}\0`)) sessionByEpoch.delete(key);
      }
      barrierByAgent.set(agentId, currentBarrier(agentId) + 1);
      activeTurnByAgent.delete(agentId);
      const states = turnsByAgent.get(agentId);
      if (states) {
        for (const [key, state] of [...states]) {
          if (!state.handle) {
            diagnostic(agentId, "timeline_fallback_rejected", "barrier");
            deleteState(agentId, key);
          }
        }
      }
      const result = appendTrackedEntry(
        dir,
        createSystemEntry(barrierType, stamp.toISOString(), forgottenSessionId),
        stamp,
      );
      handleTrackedResult(agentId, null, result);
      return true;
    },
    pendingIdleResetEvents(agentId) {
      const state = readResumeControlState(dirFor(agentId));
      return state.kind === "state" ? state.state.pendingIdleResetEvents.map((event) => ({ ...event })) : [];
    },
    acknowledgeIdleResetEvent(agentId, eventId) {
      const dir = dirFor(agentId);
      if (!prepareTimelineDirectory(dir)) return false;
      return updateResumeControlState(dir, (state) => ({
        ...state,
        pendingIdleResetEvents: state.pendingIdleResetEvents.filter((event) => event.eventId !== eventId),
      }));
    },
  };

  function appendStallMarker(agentId: string, type: SystemEntryType, sessionId: string): boolean {
    retryPending(agentId);
    const dir = dirFor(agentId);
    if (!prepareTimelineDirectory(dir)) return false;
    const stamp = now();
    const persisted = updateResumeControlState(dir, (state) => ({
      ...state,
      attemptedSessionId: type === "stall_recovery_attempt" ? sessionId : null,
      fullBarrier: null,
    }));
    if (!persisted) return false;
    const result = appendTrackedEntry(dir, createSystemEntry(type, stamp.toISOString(), sessionId), stamp);
    handleTrackedResult(agentId, null, result);
    return true;
  }
}
