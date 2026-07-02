/**
 * ChildProcessRuntimeSession — the generic child-process host for CLI drivers.
 *
 * It owns the spawned process, line-buffers stdout, runs each complete line
 * through `driver.parseLine`, and re-emits the resulting `ParsedEvent`s. The
 * driver supplies the runtime-specific behavior; this class is the uniform
 * plumbing (start / send / stop / event fan-out) the daemon talks to.
 *
 * In-process SDK drivers (pi) do NOT use this — they return their own
 * EventEmitter-based session from `createSession` and throw from `spawn`.
 */
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { Driver, LaunchContext, StdinMode } from "../types.js";
import { killProcessTree } from "./killTree.js";

/**
 * A flattened, daemon-facing description of how a runtime behaves, derived
 * purely from the driver's declared capabilities. Lets the daemon reason about
 * transport/lifecycle without knowing the concrete driver.
 */
export interface RuntimeSessionDescriptor {
  transport: "child_process";
  lifecycle: "turn_based" | "persistent_stream";
  input: {
    initial: "start";
    idle: "stdin" | "unsupported";
    busy: "stdin_steer" | "unsupported";
  };
  readiness: "spawned";
  turnBoundary: "process_exit" | "parsed_event";
  startPolicy: "immediate" | "defer_until_concrete_message";
  inFlightWake: DriverInFlightWake;
  busyDelivery: string;
  postTurn: "terminate_process" | "close_stdin" | "keep_alive";
}

type DriverInFlightWake = "steer" | "queue" | "spawn_new" | "coalesce_into_pending";

export function descriptorFromDriver(driver: Driver): RuntimeSessionDescriptor {
  const lifecycle = driver.lifecycle.kind === "per_turn" ? "turn_based" : "persistent_stream";
  const idle = driver.supportsStdinNotification ? "stdin" : "unsupported";
  const busy = driver.supportsStdinNotification ? "stdin_steer" : "unsupported";
  return {
    transport: "child_process",
    lifecycle,
    input: { initial: "start", idle, busy },
    readiness: "spawned",
    turnBoundary: driver.lifecycle.kind === "per_turn" ? "process_exit" : "parsed_event",
    startPolicy: driver.lifecycle.kind === "per_turn" ? driver.lifecycle.start : "immediate",
    inFlightWake: driver.lifecycle.inFlightWake,
    busyDelivery: driver.busyDeliveryMode,
    postTurn: driver.terminateProcessOnTurnEnd
      ? "terminate_process"
      : driver.endStdinOnTurnEnd
        ? "close_stdin"
        : "keep_alive",
  };
}

export interface StartInput {
  text: string;
  sessionId?: string;
}
export interface SendInput {
  text: string;
  sessionId?: string;
  mode?: StdinMode;
}

export class ChildProcessRuntimeSession {
  readonly descriptor: RuntimeSessionDescriptor;
  private readonly events = new EventEmitter();
  private process: ChildProcess | null = null;
  private started = false;
  private stdoutBuffer = "";
  private requestedStopReason?: string;

  constructor(
    private readonly driver: Driver,
    private readonly ctx: LaunchContext,
  ) {
    this.descriptor = descriptorFromDriver(driver);
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }
  get currentSessionId(): string | null {
    return this.driver.currentSessionId;
  }
  get exitCode(): number | null {
    return this.process?.exitCode ?? null;
  }
  get signalCode(): NodeJS.Signals | null {
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
    const launchCtx: LaunchContext = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    const { process: proc } = await this.driver.spawn(launchCtx);
    this.process = proc;
    this.attachProcess(proc);
    return { ok: true, acceptedAs: "prompt" };
  }

  /** Write a mid-session message (idle prompt or busy steer) to stdin. */
  send(input: SendInput): { ok: boolean; acceptedAs?: string; reason?: string } {
    const proc = this.process;
    if (!proc || this.closed) return { ok: false, reason: "closed" };
    const encoded = this.driver.encodeStdinMessage(input.text, input.sessionId ?? null, { mode: input.mode });
    if (!encoded) return { ok: false, reason: "unsupported" };
    proc.stdin?.write(encoded + "\n");
    return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
  }

  async stop(opts?: { reason?: string; signal?: NodeJS.Signals; forceAfterMs?: number }): Promise<void> {
    const proc = this.process;
    if (!proc || this.closed) return;
    this.requestedStopReason = opts?.reason;
    const pid = proc.pid;
    if (pid) {
      await killProcessTree(pid, { graceMs: opts?.forceAfterMs ?? 2000 });
    } else {
      proc.kill(opts?.signal ?? "SIGTERM");
    }
  }

  /** Wire stdout line-buffering → parseLine → runtime_event, plus lifecycle. */
  private attachProcess(proc: ChildProcess): void {
    proc.stdout?.on("data", (chunk: Buffer) => {
      const chunkText = chunk.toString();
      this.events.emit("stdout", chunkText);
      this.stdoutBuffer += chunkText;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const event of this.driver.parseLine(line)) {
          this.events.emit("runtime_event", event);
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
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

export function createChildProcessRuntimeSession(driver: Driver, ctx: LaunchContext): ChildProcessRuntimeSession {
  return new ChildProcessRuntimeSession(driver, ctx);
}
