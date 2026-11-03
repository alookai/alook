/** In-process lane with live-streaming prompt/steer protection. */
import { EventEmitter } from "events";
import type {
  AdapterEvent,
  InputMode,
  LaneAdmission,
  LaneSendInput,
  LaneStartInput,
  RuntimeLane,
  RuntimeLaneEventMap,
  VendorSessionHandle,
} from "../internal/adapter.js";
import type { InputReference, SessionAcquisition } from "../contract.js";

/** Poll briefly before degrading an idle prompt to a safe steer. */
const IDLE_PROMPT_RETRY_MS = 25;
const IDLE_PROMPT_MAX_WAIT_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SdkLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private sentInit = false;
  private admissionSequence = 0;

  constructor(
    private readonly handle: VendorSessionHandle,
    private readonly sessionId: string,
    private readonly options: { terminalOnPromptSettled?: boolean; acquisition?: SessionAcquisition } = {},
  ) {}

  on<K extends keyof RuntimeLaneEventMap>(
    event: K,
    listener: (value: RuntimeLaneEventMap[K]) => void,
  ): void {
    this.events.on(event, listener);
  }

  reportUnexpectedExit(info: { code?: number | null; signal?: string | null } = {}): void {
    this.events.emit("exit", {
      code: info.code ?? null,
      signal: info.signal ?? null,
      reason: "runtime_exit",
    });
  }

  emitEvents(events: AdapterEvent[]): void {
    if (!this.sentInit && events.length > 0) {
      this.sentInit = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId: this.sessionId, ...(this.options.acquisition ? { acquisition: this.options.acquisition } : {}) } as AdapterEvent);
    }
    for (const e of events) this.events.emit("runtime_event", e);
  }

  start(input: LaneStartInput): Promise<LaneAdmission> {
    return this.send({ ...input, mode: "idle" });
  }

  /** Delivers immediately; failures return through normalized events. */
  send(input: LaneSendInput): Promise<LaneAdmission> {
    const receipt = input.terminalOwner ?? `${this.sessionId}:sdk:${++this.admissionSequence}`;
    void this.deliver(input.text, input.mode, receipt, input.inputs ?? []);
    return Promise.resolve({
      ok: true,
      acceptedAs: input.mode === "busy" ? "steer" : "prompt",
      receipt,
    });
  }

  private async deliver(text: string, mode: InputMode, terminalOwner?: string, inputs: readonly InputReference[] = []): Promise<void> {
    let steering = mode === "busy";
    try {
      if (mode === "busy") {
        steering = true;
        await this.handle.steer(text);
        return;
      }
      const stillStreaming = this.handle.isStreaming && !(await this.waitForStreamingToClear());
      if (stillStreaming) {
        if (this.options.terminalOnPromptSettled) {
          this.emitEvents([
            { kind: "error", message: "SDK remained busy before the next owned prompt" },
            { kind: "turn_end", sessionId: this.sessionId, turnOwner: terminalOwner, outcome: "failed" },
          ]);
          return;
        }
        steering = true;
        await this.handle.steer(text);
        return;
      }
      try {
        await this.handle.prompt(text);
        if (this.options.terminalOnPromptSettled) {
          this.emitEvents([{ kind: "turn_end", sessionId: this.sessionId, turnOwner: terminalOwner, outcome: "success" }]);
        }
      } catch (err) {
        this.emitEvents([
          { kind: "error", message: errorMessage(err) },
          { kind: "turn_end", sessionId: this.sessionId, turnOwner: terminalOwner, outcome: "failed" },
        ]);
      }
    } catch (err) {
      this.emitEvents(steering
        ? [{ kind: "input_returned", inputs, evidence: "unknown", reason: errorMessage(err), retryable: false }]
        : [{ kind: "error", message: errorMessage(err), scope: "turn" }]);
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
