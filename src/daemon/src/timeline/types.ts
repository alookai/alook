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
 * A timeline row — exactly four fields (gustavo's final schema). Per-turn
 * history: what the agent SAW (`messages`, with their own timestamps) and what it
 * SAID (`agent_responses`), the runtime `session_id` (resume target), and the
 * `provider` that ran it. No task_id / datetime / status / pid / errmsg — the
 * log is append-only and time is carried by the messages themselves.
 */
export interface ContextTimelineEntry {
  /** Agent runtime session id (null until the runtime reports session_init). */
  session_id: string | null;
  /**
   * The messages the agent actually saw this turn — the verbatim payload of the
   * `inbox pull` that opened this entry ("what I saw"), read against
   * `agent_responses` ("what I said"). Carries each message's own `time`.
   */
  messages: Message[];
  /** The agent's text outputs this turn ("what I said"). */
  agent_responses: string[];
  /** Runtime id this turn ran under (resume can be constrained to a provider). */
  provider: string | null;
}
