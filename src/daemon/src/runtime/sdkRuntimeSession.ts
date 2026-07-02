/**
 * SdkRuntimeSession — the in-process counterpart to ChildProcessRuntimeSession.
 *
 * `pi` doesn't spawn a child process; it runs the agent in-process
 * via a vendor SDK. They share this thin EventEmitter wrapper: the driver wires
 * the SDK's event callback to `emitEvent`, and `prompt`/`steer`/`abort`/`dispose`
 * are delegated to the SDK session. The daemon consumes the same `runtime_event`
 * stream it gets from child-process sessions, so the rest of the system is
 * transport-agnostic.
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

  /** idle → SDK prompt; busy → SDK steer. */
  async send(text: string, mode: StdinMode): Promise<{ ok: boolean }> {
    if (mode === "busy") await this.handle.steer(text);
    else await this.handle.prompt(text);
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.handle.isStreaming && this.handle.abort) await this.handle.abort();
    await this.handle.dispose?.();
  }

  get currentSessionId(): string {
    return this.sessionId;
  }
}
