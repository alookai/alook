/**
 * HermesEventNormalizer — maps Hermes Agent's quiet-mode (`-Q`) stdout into
 * `ParsedEvent`s.
 *
 * Hermes is NOT a streamed-JSON protocol like Codex/Claude. In `-Q` mode it
 * prints, to stdout:
 *   1. the final assistant response (possibly multi-line plain text), then
 *   2. a footer line carrying the session id, e.g.
 *        `session_id: <id>`   (also accepts `Session: <id>` / `Session ID: <id>`)
 *
 * So per stdout *line* we cannot know when the response ends until we see the
 * footer. Strategy: emit a `text` event for every non-footer, non-empty line,
 * and when the footer is seen, emit `session_init` (if it's the first time we
 * learn the id) followed by `turn_end`. This is the same "collapse the whole
 * transcript into a finished turn" model OpenCode uses for per_turn runs.
 *
 * Line types handled:
 *  - `session_id:` / `session:` footer  -> learn session id
 *  - `error:` / `Error:` / lines starting with `hermes:` and containing "error"
 *    -> error event (best-effort)
 *  - everything else (non-empty)        -> text event
 */
import type { ParsedEvent } from "../types.js";

const SESSION_ID_RE = /^(?:session(?:[_ ]?id)?)\s*[:=]\s*(\S+)$/i;
const ERROR_PREFIX_RE = /^(?:error|hermes:?\s*error)\s*[:]\s*(.*)$/i;

export class HermesEventNormalizer {
  private threadId: string | null = null;

  get currentSessionId(): string | null {
    return this.threadId;
  }

  adoptSessionId(sessionId: string | null): void {
    this.threadId = sessionId;
  }

  normalizeLine(line: string, fallbackSessionId?: string | null): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    // Session-id footer.
    const sidMatch = SESSION_ID_RE.exec(trimmed);
    if (sidMatch) {
      const id = sidMatch[1];
      const events: ParsedEvent[] = [];
      if (id && id !== this.threadId) {
        this.threadId = id;
        events.push({ kind: "session_init", sessionId: id });
      }
      events.push({ kind: "turn_end", sessionId: this.threadId ?? fallbackSessionId ?? undefined });
      return events;
    }

    // Error line.
    const errMatch = ERROR_PREFIX_RE.exec(trimmed);
    if (errMatch) {
      return [
        { kind: "error", message: errMatch[1].trim() || trimmed },
        { kind: "turn_end", sessionId: this.threadId ?? fallbackSessionId ?? undefined },
      ];
    }

    // Plain response text.
    return [{ kind: "text", text: trimmed }];
  }
}
