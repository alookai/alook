/**
 * ProcessLane — the generic child-process host for CLI adapters.
 *
 * It owns the spawned process, line-buffers stdout, runs each complete line
 * through `driver.normalizeLine`, and re-emits the resulting `AdapterEvent`s. The
 * driver supplies the runtime-specific behavior; this class is the uniform
 * plumbing (start / send / stop / event fan-out) the daemon talks to.
 *
 * In-process SDK drivers (pi) do NOT use this — they return their own
 * EventEmitter-based session from `openSdkSession` and throw from `spawn`.
 */
import { EventEmitter } from "events";
import type {
  BackendAdapter,
  BackendConfig,
  AdapterLaunchContext,
  InputMode,
  SpawnedProcessHandle,
} from "../internal/adapter.js";
import type { BuiltinBackendId } from "../contract.js";
import { killProcessTree, SESSION_STOP_GRACE_MS } from "../internal/killTree.js";

interface StartInput {
  text: string;
  sessionId?: string;
}
interface SendInput {
  text: string;
  sessionId?: string;
  mode?: InputMode;
}

interface ProcessLaneOptions {
  /** Observability-only tap for each complete non-empty stdout line, before parsing. */
  onRawStdoutLine?: (line: string) => void;
}

export class ProcessLane<Id extends string = BuiltinBackendId, Config = BackendConfig> {
  private readonly events = new EventEmitter();
  private process: SpawnedProcessHandle | null = null;
  private started = false;
  private stdoutBuffer = "";
  private requestedStopReason?: string;

  constructor(
    private readonly driver: BackendAdapter<Id, Config>,
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

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.events.on(event, cb);
  }

  /** Spawn the process and deliver the initial prompt (handled inside spawn). */
  async start(input: StartInput): Promise<{ ok: boolean; acceptedAs?: string; reason?: string; error?: string }> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    this.started = true;
    const launchCtx: AdapterLaunchContext<Id, Config> = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    if (!this.driver.spawn) throw new Error(`Backend ${this.driver.id} has no process launcher`);
    const { process: proc } = await this.driver.spawn(launchCtx);
    this.process = proc;
    this.attachProcess(proc);
    return { ok: true, acceptedAs: "prompt" };
  }

  /** Write a mid-session message (idle prompt or busy steer) to stdin. */
  send(input: SendInput): { ok: boolean; acceptedAs?: string; reason?: string } {
    const proc = this.process;
    if (!proc || this.closed) return { ok: false, reason: "closed" };
    const encoded = this.driver.encodeMessage(input.text, input.sessionId ?? null, { mode: input.mode });
    if (!encoded) return { ok: false, reason: "unsupported" };
    proc.stdin?.write(encoded + "\n");
    return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
  }

  async stop(opts?: { reason?: string; signal?: "SIGTERM" | "SIGINT" | "SIGKILL"; forceAfterMs?: number }): Promise<void> {
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

  interrupt(): boolean {
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
          this.events.emit("runtime_event", event);
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    });
    proc.on("error", (err) => this.events.emit("error", err));
    proc.on("exit", (code, signal) =>
      this.events.emit("exit", { code, signal, reason: this.requestedStopReason ? "requested" : "runtime_exit" }),
    );
    proc.on("close", (code, signal) =>
      this.events.emit("close", { code, signal, reason: this.requestedStopReason ? "requested" : "runtime_exit" }),
    );
  }
}

export function createProcessLane<Id extends string, Config>(
  driver: BackendAdapter<Id, Config>,
  ctx: AdapterLaunchContext<Id, Config>,
  opts?: ProcessLaneOptions,
): ProcessLane<Id, Config> {
  return new ProcessLane(driver, ctx, opts);
}
