/**
 * SdkLane — the in-process counterpart to ProcessLane.
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
import type { AdapterEvent, VendorSessionHandle, InputMode } from "../internal/adapter.js";

/** What a vendor SDK session must expose for the wrapper to drive it. */
/** How long, and how often, to poll `isStreaming` before giving up and
 * steering instead of prompting a still-busy session.
 *
 * `IDLE_PROMPT_RETRY_MS = 25` is short enough that a session which finishes
 * within one turn boundary (~100-300ms) is caught on the first or second
 * poll, and small enough that the busy-wait cost is negligible.
 * `IDLE_PROMPT_MAX_WAIT_MS = 1000` is the ceiling before we accept the
 * session is "genuinely still working" and fall through to `steer` — anything
 * higher measurably delays first-token latency without changing outcomes in
 * the traces we've captured.
 */
const IDLE_PROMPT_RETRY_MS = 25;
const IDLE_PROMPT_MAX_WAIT_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SdkLane {
  private readonly events = new EventEmitter();
  private sentInit = false;

  constructor(
    private readonly handle: VendorSessionHandle,
    private readonly sessionId: string,
  ) {}

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.events.on(event, cb);
  }

  /** BackendAdapter calls this from the SDK's event callback with mapped events. */
  emitEvents(events: AdapterEvent[]): void {
    if (!this.sentInit && events.length > 0) {
      this.sentInit = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId: this.sessionId } as AdapterEvent);
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
   * the logical session controller, which starts the first turn this way, keeps
   * treating the agent as busy/running until the stall watchdog eventually
   * notices no progress and terminates it minutes later.
   */
  send(text: string, mode: InputMode): Promise<{ ok: boolean }> {
    // Vendor prompt()/steer() promises settle when the whole turn finishes,
    // not when the command is admitted. Start delivery immediately, but let
    // the public receipt resolve now so callers can steer or interrupt the
    // live turn. deliver() owns every asynchronous failure and translates it
    // into normalized events, so this cannot create an unhandled rejection.
    void this.deliver(text, mode);
    return Promise.resolve({ ok: true });
  }

  private async deliver(text: string, mode: InputMode): Promise<void> {
    try {
      if (mode === "busy") {
        await this.handle.steer(text);
        return;
      }
      const stillStreaming = this.handle.isStreaming && !(await this.waitForStreamingToClear());
      if (stillStreaming) {
        await this.handle.steer(text);
        return;
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

  async interrupt(): Promise<boolean> {
    if (!this.handle.isStreaming || !this.handle.abort) return false;
    await this.handle.abort();
    return true;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }
}
