/**
 * HermesEventNormalizer — maps Hermes Agent's quiet-mode (`-Q`) stdout into
 * `ParsedEvent`s.
 *
 * VERIFIED AGAINST THE REAL BINARY (this host): `hermes chat -q "<p>" -Q
 * --pass-session-id --model nous` prints exactly the final assistant response
 * (CRLF-terminated, no trailing banner) and then the process exits. It does
 * NOT emit a `session_id:` footer — so unlike Codex/Claude, there is no
 * in-band turn-end marker.
 *
 * Because the daemon only ends a turn on a `turn_end` runtime_event (see
 * managerRuntime.ts — process `exit` alone does not), this normalizer emits
 * `turn_end` itself. To stay correct for multi-line answers, it:
 *   - emits `text` for every non-empty response line (text keeps streaming to
 *     the timeline even after the turn is marked ended), and
 *   - emits `turn_end` exactly once, after the first text line.
 *
 * A `session_id:` / `Session ID:` / `session:` footer (future Hermes builds,
 * or a wrapper) is still honored: it emits `session_init` + `turn_end`.
 */
import type { ParsedEvent } from "../types.js";

const SESSION_ID_RE = /^(?:session(?:[_ ]?id)?)\s*[:=]\s*(\S+)$/i;
const ERROR_PREFIX_RE = /^(?:error|hermes:?\s*error)\s*[:]\s*(.*)$/i;

export class HermesEventNormalizer {
  private threadId: string | null = null;
  private turnEnded = false;

  get currentSessionId(): string | null {
    return this.threadId;
  }

  adoptSessionId(sessionId: string | null): void {
    this.threadId = sessionId;
    if (sessionId) this.turnEnded = false;
  }

  normalizeLine(line: string, fallbackSessionId?: string | null): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    // Footer (if present): learn session id, then end the turn.
    const sidMatch = SESSION_ID_RE.exec(trimmed);
    if (sidMatch) {
      const id = sidMatch[1];
      const events: ParsedEvent[] = [];
      if (id && id !== this.threadId) {
        this.threadId = id;
        events.push({ kind: "session_init", sessionId: id });
      }
      if (!this.turnEnded) {
        this.turnEnded = true;
        events.push({ kind: "turn_end", sessionId: this.threadId ?? fallbackSessionId ?? undefined });
      }
      return events;
    }

    // Error line.
    const errMatch = ERROR_PREFIX_RE.exec(trimmed);
    if (errMatch) {
      const out: ParsedEvent[] = [{ kind: "error", message: errMatch[1].trim() || trimmed }];
      if (!this.turnEnded) {
        this.turnEnded = true;
        out.push({ kind: "turn_end", sessionId: this.threadId ?? fallbackSessionId ?? undefined });
      }
      return out;
    }

    // Plain response text. Emit it, and close the turn once (after the first
    // line) since the real Hermes -Q output carries no in-band end marker.
    const out: ParsedEvent[] = [{ kind: "text", text: trimmed }];
    if (!this.turnEnded) {
      this.turnEnded = true;
      out.push({ kind: "turn_end", sessionId: this.threadId ?? fallbackSessionId ?? undefined });
    }
    return out;
  }
}
