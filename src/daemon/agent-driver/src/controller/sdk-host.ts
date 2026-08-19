/** In-process lane with live-streaming prompt/steer protection. */
import { EventEmitter } from "events";
import type { AdapterEvent, VendorSessionHandle, InputMode } from "../internal/adapter.js";

/** Poll briefly before degrading an idle prompt to a safe steer. */
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

  reportUnexpectedExit(info: { code?: number | null; signal?: string | null } = {}): void {
    this.events.emit("exit", info);
  }

  emitEvents(events: AdapterEvent[]): void {
    if (!this.sentInit && events.length > 0) {
      this.sentInit = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId: this.sessionId } as AdapterEvent);
    }
    for (const e of events) this.events.emit("runtime_event", e);
  }

  /** Delivers immediately; failures return through normalized events. */
  send(text: string, mode: InputMode, terminalOwner?: string): Promise<{ ok: boolean }> {
    void this.deliver(text, mode, terminalOwner);
    return Promise.resolve({ ok: true });
  }

  private async deliver(text: string, mode: InputMode, terminalOwner?: string): Promise<void> {
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
          { kind: "turn_end", sessionId: this.sessionId, turnOwner: terminalOwner },
        ]);
      }
    } catch (err) {
      this.emitEvents([{ kind: "error", message: errorMessage(err) }]);
    }
  }

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
