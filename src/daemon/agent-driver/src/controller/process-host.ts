/**
 * ProcessLane — the generic child-process host for CLI adapters.
 *
 * It owns the spawned process, line-buffers stdout, runs each complete line
 * through `driver.normalizeLine`, and re-emits the resulting `AdapterEvent`s. The
 * driver supplies the runtime-specific behavior; this class is the uniform
 * plumbing (start / send / stop / event fan-out) the daemon talks to.
 *
 * In-process SDK adapters (Pi) do not use this helper; their `openLane()`
 * returns a runtime lane backed directly by the vendor session.
 */
import { EventEmitter } from "events";
import type {
  BackendConfig,
  AdapterLaunchContext,
  BackendExecution,
  LaneAdmission,
  LaneSendInput,
  LaneStartInput,
  LaneStopInput,
  RuntimeLane,
  RuntimeLaneEventMap,
  SpawnedProcess,
  SpawnedProcessHandle,
} from "../internal/adapter.js";
import type { BuiltinBackendId } from "../contract.js";
import { killProcessTree, SESSION_STOP_GRACE_MS } from "../internal/killTree.js";

const DEFAULT_PROMPT_ADMISSION_TIMEOUT_MS = 60_000;

interface ProcessLaneOptions {
  /** Observability-only tap for each complete non-empty stdout line, before parsing. */
  onRawStdoutLine?: (line: string) => void;
  /** One-shot adapters that do not exit promptly after terminal output. */
  stopAfterTurn?: boolean;
  /** Maximum time to wait for a vendor/transport-owned turn receipt. */
  promptAdmissionTimeoutMs?: number;
}

export interface ProcessAdapterPrimitives<Id extends string, Config> {
  readonly id: Id;
  readonly execution: BackendExecution;
  readonly currentSessionId: string | null;
  spawn(ctx: AdapterLaunchContext<Id, Config>): Promise<SpawnedProcess>;
  normalizeLine(line: string): import("../internal/adapter.js").AdapterEvent[];
  encodeMessage(
    text: string,
    sessionId: string | null,
    opts?: import("../internal/adapter.js").EncodeMessageOptions,
  ): string | null;
}

export class ProcessLane<Id extends string = BuiltinBackendId, Config = BackendConfig> implements RuntimeLane {
  private readonly events = new EventEmitter();
  private process: SpawnedProcessHandle | null = null;
  private started = false;
  private stdoutBuffer = "";
  private requestedStopReason?: string;
  private admissionSequence = 0;
  private activeTerminalReceipt?: string;
  private stopPromise?: Promise<void>;
  private pendingPromptAdmission?: {
    resolve(admission: LaneAdmission): void;
    timer?: ReturnType<typeof setTimeout>;
  };

  constructor(
    private readonly driver: ProcessAdapterPrimitives<Id, Config>,
    private readonly ctx: AdapterLaunchContext<Id, Config>,
    private readonly opts: ProcessLaneOptions = {},
  ) {}

  get pid(): number | undefined {
    return this.process?.pid;
  }
  get currentSessionId(): string | null {
    return this.driver.currentSessionId;
  }
  get exitCode(): number | null {
    return this.process?.exitCode ?? null;
  }
  get signalCode(): string | null {
    return this.process?.signalCode ?? null;
  }
  get closed(): boolean {
    return this.process ? this.process.exitCode != null || this.process.signalCode != null : false;
  }

  on<K extends keyof RuntimeLaneEventMap>(
    event: K,
    listener: (value: RuntimeLaneEventMap[K]) => void,
  ): void {
    this.events.on(event, listener);
  }

  /** Spawn the process and deliver the initial prompt (handled inside spawn). */
  async start(input: LaneStartInput): Promise<LaneAdmission> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    this.started = true;
    const launchCtx: AdapterLaunchContext<Id, Config> = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    const pendingAuthority = !input.terminalOwner && this.requiresAuthoritativeOwner()
      ? this.admitPrompt(undefined, `${this.driver.id}:process:${this.ctx.launchId}`)
      : undefined;
    let spawned: SpawnedProcess;
    try {
      spawned = await this.driver.spawn(launchCtx);
    } catch (error) {
      this.settlePendingPrompt({ ok: false, reason: "runtime_error", error: String(error) });
      throw error;
    }
    const { process: proc } = spawned;
    this.process = proc;
    this.attachProcess(proc);
    this.armPendingPromptTimeout();
    if (this.driver.execution.lifetime === "session" && !this.writableStdin(proc)) {
      const rejection = this.stdinUnavailableAdmission();
      this.settlePendingPrompt(rejection);
      return pendingAuthority ?? rejection;
    }
    return pendingAuthority
      ?? this.admitPrompt(input.terminalOwner, `${this.driver.id}:process:${proc.pid ?? this.ctx.launchId}`);
  }

  /** Write a mid-session message (idle prompt or busy steer) to stdin. */
  async send(input: LaneSendInput): Promise<LaneAdmission> {
    const proc = this.process;
    if (!proc || this.closed) return { ok: false, reason: "closed" };
    const stdin = this.writableStdin(proc);
    if (!stdin) return this.stdinUnavailableAdmission();
    if (input.mode === "idle" && this.pendingPromptAdmission) {
      return { ok: false, reason: "runtime_busy", error: "prompt admission is already pending" };
    }
    const encoded = this.driver.encodeMessage(input.text, input.sessionId ?? null, { mode: input.mode });
    if (!encoded) return { ok: false, reason: "unsupported" };
    if (input.mode === "idle") {
      const admission = this.admitPrompt(input.terminalOwner, `${this.driver.id}:send:${++this.admissionSequence}`);
      try {
        stdin.write(encoded + "\n");
      } catch (error) {
        this.activeTerminalReceipt = undefined;
        this.settlePendingPrompt({ ok: false, reason: "runtime_error", error: String(error) });
        throw error;
      }
      return admission;
    }
    stdin.write(encoded + "\n");
    const receipt = input.terminalOwner ?? `${this.driver.id}:send:${++this.admissionSequence}`;
    return {
      ok: true,
      acceptedAs: "steer",
      receipt,
    };
  }

  private admitPrompt(terminalOwner: string | undefined, fallbackReceipt: string): Promise<LaneAdmission> {
    if (terminalOwner) {
      this.activeTerminalReceipt = terminalOwner;
      return Promise.resolve({ ok: true, acceptedAs: "prompt", receipt: terminalOwner });
    }
    if (!this.requiresAuthoritativeOwner()) {
      this.activeTerminalReceipt = fallbackReceipt;
      return Promise.resolve({ ok: true, acceptedAs: "prompt", receipt: fallbackReceipt });
    }
    return new Promise<LaneAdmission>((resolve) => {
      this.pendingPromptAdmission = { resolve };
      this.armPendingPromptTimeout();
    });
  }

  private armPendingPromptTimeout(): void {
    const pending = this.pendingPromptAdmission;
    if (!this.process || !pending || pending.timer) return;
    pending.timer = setTimeout(() => {
      if (this.pendingPromptAdmission !== pending) return;
      this.settlePendingPrompt({
        ok: false,
        reason: "admission_timeout",
        error: "runtime did not acknowledge command admission before the deadline",
      });
      void this.stop({ reason: "admission_timeout", forceAfterMs: 0 }).catch(() => {});
    }, this.opts.promptAdmissionTimeoutMs ?? DEFAULT_PROMPT_ADMISSION_TIMEOUT_MS);
    pending.timer.unref?.();
  }

  private writableStdin(proc: SpawnedProcessHandle): NonNullable<SpawnedProcessHandle["stdin"]> | null {
    const stdin = proc.stdin;
    return stdin && !stdin.destroyed && !stdin.writableEnded && stdin.writable !== false ? stdin : null;
  }

  private stdinUnavailableAdmission(): LaneAdmission {
    return {
      ok: false,
      reason: "stdin_unavailable",
      error: "runtime stdin is not writable",
    };
  }

  private requiresAuthoritativeOwner(): boolean {
    return this.driver.execution.terminalOwnership === "vendor_message"
      || this.driver.execution.terminalOwnership === "transport_request";
  }

  private settlePendingPrompt(admission: LaneAdmission): void {
    const pending = this.pendingPromptAdmission;
    if (!pending) return;
    this.pendingPromptAdmission = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    if (admission.ok) this.activeTerminalReceipt = admission.receipt;
    pending.resolve(admission);
  }

  stop(opts: LaneStopInput = {}): Promise<void> {
    this.settlePendingPrompt({ ok: false, reason: "closed", error: "runtime lane stopped before command admission" });
    if (!this.process || this.closed) return Promise.resolve();
    this.stopPromise ??= this.stopProcess(opts);
    return this.stopPromise;
  }

  private async stopProcess(opts: LaneStopInput): Promise<void> {
    const proc = this.process;
    if (!proc || this.closed) return;
    this.requestedStopReason = opts?.reason;
    const pid = proc.pid;
    if (pid) {
      await killProcessTree(pid, { graceMs: opts?.forceAfterMs ?? SESSION_STOP_GRACE_MS });
    } else {
      proc.kill(opts?.signal ?? "SIGTERM");
    }
  }

  async interrupt(): Promise<boolean> {
    const proc = this.process;
    if (!proc || this.closed) return false;
    return proc.kill("SIGINT");
  }

  /** Wire stdout line-buffering → normalizeLine → runtime_event, plus lifecycle. */
  private attachProcess(proc: SpawnedProcessHandle): void {
    proc.stdout?.on("data", (chunk) => {
      const chunkText = chunk.toString();
      this.events.emit("stdout", chunkText);
      this.stdoutBuffer += chunkText;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.opts.onRawStdoutLine?.(line);
        } catch {
          /* an observability tap cannot alter runtime parsing */
        }
        for (const event of this.driver.normalizeLine(line)) {
          if (event.kind === "turn_owner" && event.receipt.trim()) {
            this.settlePendingPrompt({ ok: true, acceptedAs: "prompt", receipt: event.receipt });
          } else if (event.kind === "error" && this.pendingPromptAdmission) {
            this.settlePendingPrompt({ ok: false, reason: "runtime_error", error: event.message });
          }
          const ownedEvent = event.kind === "turn_end" && !event.turnOwner && this.activeTerminalReceipt
            ? { ...event, turnOwner: this.activeTerminalReceipt }
            : event;
          this.events.emit("runtime_event", ownedEvent);
          const ownsTerminal = ownedEvent.kind === "turn_end"
            && Boolean(this.activeTerminalReceipt)
            && ownedEvent.turnOwner === this.activeTerminalReceipt;
          if (ownsTerminal) this.activeTerminalReceipt = undefined;
          if (ownsTerminal && this.opts.stopAfterTurn) {
            void this.stop({ reason: "turn_complete", forceAfterMs: 2_000 });
          }
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    });
    proc.on("error", (err) => {
      this.settlePendingPrompt({ ok: false, reason: "runtime_error", error: String(err) });
      this.events.emit("error", err);
    });
    proc.on("exit", (code, signal) => {
      this.settlePendingPrompt({ ok: false, reason: "closed", error: "runtime exited before command admission" });
      this.events.emit("exit", { code, signal, reason: this.requestedStopReason ? "requested" : "runtime_exit" });
    });
  }
}

export function createProcessLane<Id extends string, Config>(
  driver: ProcessAdapterPrimitives<Id, Config>,
  ctx: AdapterLaunchContext<Id, Config>,
  opts?: ProcessLaneOptions,
): ProcessLane<Id, Config> {
  return new ProcessLane(driver, ctx, opts);
}
