/**
 * Context-timeline types — shared by the timeline I/O module and the manager.
 *
 * The timeline is a per-agent, per-day JSONL append-log (`.context_timeline/
 * YYYY-MM-DD.jsonl` under the agent's workdir). One line per task/turn. It is a
 * pure DAILY LOG: it does NOT participate in steering (the persistent manager
 * already owns busy-time delivery in memory via managerPolicy). It backs exactly
 * two things: a durable record of turns (agent recall), and session-id lookup for
 * resume ACROSS daemon restarts. There is no thread/context key — an agent has at
 * most one active session, so the whole file IS that agent's history.
 *
 * Host-neutral: no platform specifics, no fs here (just types). The one import
 * is the agent-facing `Message` shape — an entry records exactly what the agent
 * saw (its inbox-pull payload), so it reuses that contract type verbatim.
 */
import type { Message } from "../server/contract.js";

/**
 * A timeline row. Two shapes share the file, discriminated by `system`:
 *
 *   - **Turn** (`system` absent): per-turn history — what the agent SAW
 *     (`messages`, with their own timestamps) and what it SAID
 *     (`agent_responses`), the runtime `session_id` (resume target), and the
 *     `provider` that ran it. The append-only log is time-ordered; each
 *     message carries its own `time`.
 *   - **System** (`system` set): an out-of-band event the daemon needs to
 *     record in-line with turns so both the resume walker AND the agent's
 *     own history read see it. `reset_session` and `nap` deliberately forget
 *     all prior conversation; stall-recovery rows persist the one allowed
 *     recovery attempt, its clean reset, and the final exact-session fence. On
 *     resume, the resolver walks newest→oldest: reset/nap rows hide older
 *     candidates, while an exact stall fence remains attached to any newer
 *     healthy candidate so stale external resume sources cannot resurrect it.
 *
 * On a system row, `session_id`/`provider` are null and `messages`/
 * `agent_responses` are empty. The system row is not mergeable with a
 * following turn (see `appendOrMergeEntry`).
 */
// Stall recovery uses durable attempt/clear markers plus a final barrier so a
// daemon restart cannot replenish the same poisoned session's retry allowance.
export type SystemEntryType =
  | "reset_session"
  | "nap"
  | "stall_recovery_attempt"
  | "stall_recovery_clear"
  | "stall_recovery";

export interface SystemEntry {
  /** Event kind. Extend by adding to `SystemEntryType`. */
  type: SystemEntryType;
  /** ISO timestamp when the event landed — the row is otherwise untimed. */
  time: string;
  /** Exact backend session associated with a stall-recovery row. */
  backend_session_id?: string;
}

export interface ContextTimelineEntry {
  /** Agent runtime session id (null until the runtime reports session_init; always null on system rows). */
  session_id: string | null;
  /**
   * The messages the agent actually saw this turn — the verbatim payload of the
   * `inbox pull` that opened this entry ("what I saw"), read against
   * `agent_responses` ("what I said"). Carries each message's own `time`.
   * Empty on system rows.
   */
  messages: Message[];
  /** The agent's text outputs this turn ("what I said"). Empty on system rows. */
  agent_responses: string[];
  /** Runtime id this turn ran under (resume can be constrained to a provider). Null on system rows. */
  provider: string | null;
  /** Present iff this row is a system event, not a turn. */
  system?: SystemEntry;
}
