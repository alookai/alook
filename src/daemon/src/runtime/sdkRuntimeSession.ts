/**
 * SdkRuntimeSession — the in-process counterpart to ChildProcessRuntimeSession.
 *
 * `pi` doesn't spawn a child process; it runs the agent in-process
 * via a vendor SDK. They share this thin EventEmitter wrapper: the driver wires
 * the SDK's event callback to `emitEvent`, and `prompt`/`steer`/`abort`/`dispose`
 * are delegated to the SDK session. The daemon consumes the same `runtime_event`
 * stream it gets from child-process sessions, so the rest of the system is
 * transport-agnostic.
 *
 * `send()`'s idle path is a second, independent line of defense against
 * "Agent is already processing" (the manager's own busy/idle bookkeeping in
 * `managerPolicy.ts` is the first — see `plans/wire-pi-runtime-execution.md`'s
 * follow-up section). It doesn't trust the caller's `mode: "idle"` at face
 * value; it re-checks the vendor SDK's live `isStreaming` at the moment of
 * delivery and degrades to a `steer()` instead of ever calling `prompt()` on
 * a session that's actually still busy. That way a future FSM bug (a
 * different driver, a race we haven't hit yet) can't reach the vendor SDK's
 * own throw — worst case it steers instead of prompting, which is always a
 * legal call. See plans/sdk-runtime-session-live-isstreaming-guard.md.
 */
import { EventEmitter } from "events";
import type { ParsedEvent, StdinMode } from "../types.js";

/** What a vendor SDK session must expose for the wrapper to drive it. */
export interface SdkSessionHandle {
  prompt(text: string): void | Promise<void>;
  steer(text: string): void | Promise<void>;
  abort?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  readonly isStreaming?: boolean;
}

/** How long, and how often, to poll `isStreaming` before giving up and
 * steering instead of prompting a still-busy session. */
const IDLE_PROMPT_RETRY_MS = 25;
const IDLE_PROMPT_MAX_WAIT_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SdkRuntimeSession {
  private readonly events = new EventEmitter();
  private sentInit = false;

  constructor(
    private readonly handle: SdkSessionHandle,
    private readonly sessionId: string,
  ) {}

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.events.on(event, cb);
  }

  /** Driver calls this from the SDK's event callback with mapped events. */
  emitEvents(events: ParsedEvent[]): void {
    if (!this.sentInit && events.length > 0) {
      this.sentInit = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId: this.sessionId } as ParsedEvent);
    }
    for (const e of events) this.events.emit("runtime_event", e);
  }

  /**
   * busy → SDK steer, always. idle → SDK prompt, UNLESS the handle reports
   * it's still streaming right now, in which case wait briefly for it to
   * clear and fall back to steer() if it doesn't — see the class doc comment.
   * Never rejects: a vendor SDK exception is reported as a normal
   * `runtime_event` (`{kind: "error"}`) instead, so callers can treat
   * `send()` as fire-and-forget without an unhandled rejection.
   *
   * A failed `prompt()` also gets a synthetic `turn_end` right behind its
   * `error` event — unlike a failed `steer()` (which injects into an
   * *already-running* turn that will still emit its own real `turn_end`
   * later regardless of whether the steer landed), a `prompt()` call IS the
   * attempted turn: if it throws, no turn ever started and nothing else
   * will ever say this one is over. Without this, the caller (see
   * `SdkManagedSession.start()`, which fires the first turn this way) keeps
   * treating the agent as busy/running until the stall watchdog eventually
   * notices no progress and terminates it minutes later.
   */
  async send(text: string, mode: StdinMode): Promise<{ ok: boolean }> {
    try {
      if (mode === "busy") {
        await this.handle.steer(text);
        return { ok: true };
      }
      const stillStreaming = this.handle.isStreaming && !(await this.waitForStreamingToClear());
      if (stillStreaming) {
        await this.handle.steer(text);
        return { ok: true };
      }
      try {
        await this.handle.prompt(text);
      } catch (err) {
        this.emitEvents([
          { kind: "error", message: errorMessage(err) },
          { kind: "turn_end", sessionId: this.sessionId },
        ]);
      }
    } catch (err) {
      this.emitEvents([{ kind: "error", message: errorMessage(err) }]);
    }
    return { ok: true };
  }

  /** Polls `handle.isStreaming` until it clears or the deadline passes. Returns true once cleared. */
  private async waitForStreamingToClear(): Promise<boolean> {
    const deadline = Date.now() + IDLE_PROMPT_MAX_WAIT_MS;
    while (this.handle.isStreaming) {
      if (Date.now() >= deadline) return false;
      await delay(IDLE_PROMPT_RETRY_MS);
    }
    return true;
  }

  async stop(): Promise<void> {
    if (this.handle.isStreaming && this.handle.abort) await this.handle.abort();
    await this.handle.dispose?.();
  }

  get currentSessionId(): string {
    return this.sessionId;
  }
}
