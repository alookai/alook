import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LaneAdmission, LaneSendInput, LaneStartInput, LaneStopInput,
  RuntimeLane, RuntimeLaneEventMap, SpawnedProcessHandle,
} from "./adapter.js";
import { killProcessTree, spawnAgentProcess, SESSION_STOP_GRACE_MS } from "./killTree.js";
import { scrubDriverErrorMessage } from "./errors.js";
import { sdkWorkerMain, type SdkWorkerFactory, type SdkWorkerInit, type SdkWorkerEvent } from "./sdk-worker-api.js";

class SdkRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class SdkWorkerLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly child: SpawnedProcessHandle;
  private readonly directory: string;
  private readonly init: SdkWorkerInit;
  private sequence = 0;
  private sessionId: string | null = null;
  private buffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private started = false;
  private stopping = false;
  private exited = false;
  private stopPromise?: Promise<void>;

  constructor(
    factory: SdkWorkerFactory,
    init: Omit<SdkWorkerInit, "moduleUrl"> & { readonly modulePath: string },
    environment: NodeJS.ProcessEnv,
  ) {
    const { modulePath, ...options } = init;
    this.init = { ...options, moduleUrl: pathToFileURL(modulePath).href };
    const source = `void (${sdkWorkerMain.toString()})(${factory.toString()});`;
    this.directory = mkdtempSync(join(tmpdir(), "alook-sdk-worker-"));
    this.events.on("error", () => {});
    const entry = join(this.directory, "worker.mjs");
    try {
      writeFileSync(entry, source, { mode: 0o600 });
      this.child = spawnAgentProcess(process.execPath, ["--experimental-import-meta-resolve", entry], { cwd: init.cwd, env: environment, shell: false });
    } catch (error) { rmSync(this.directory, { recursive: true, force: true }); throw error; }
    this.child.stdout?.on("data", (chunk) => this.read(this.stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.toString()))));
    this.child.stderr?.on("data", (chunk) => {
      const text = this.stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.toString()));
      if (text) this.events.emit("stderr", scrubDriverErrorMessage(text));
    });
    this.child.on("error", (error) => {
      this.rejectPending(error);
      this.events.emit("error", error);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.rejectPending(new Error("SDK worker exited"));
      this.events.emit("exit", { code, signal, reason: this.stopping ? "requested" : "runtime_exit" });
    });
  }

  get currentSessionId(): string | null { return this.sessionId; }

  on<K extends keyof RuntimeLaneEventMap>(event: K, listener: (value: RuntimeLaneEventMap[K]) => void): void {
    this.events.on(event, listener);
  }

  async start(input: LaneStartInput): Promise<LaneAdmission> {
    if (this.started || this.stopping) return { ok: false, reason: "closed" };
    this.started = true;
    try {
      await this.request("open", this.init);
      return await this.send({ ...input, mode: "idle" });
    } catch (error) {
      if (error instanceof SdkRequestError) return { ok: false, reason: error.code === "authentication_required" ? "authentication" : error.code, error: error.message };
      throw error;
    }
  }

  async probe(): Promise<unknown> { return this.request("open", this.init, this.init.probe?.includeModels ? 10_000 : 5_000); }

  async send(input: LaneSendInput): Promise<LaneAdmission> {
    if (this.stopping || this.exited) return { ok: false, reason: "closed" };
    return await this.request("send", input) as LaneAdmission;
  }

  async interrupt(): Promise<boolean> {
    if (this.stopping || this.exited) return false;
    return await this.request("interrupt", {}) === true;
  }

  stop(input: LaneStopInput = {}): Promise<void> {
    this.stopPromise ??= this.stopOnce(input);
    return this.stopPromise;
  }

  private async stopOnce(input: LaneStopInput): Promise<void> {
    this.stopping = true;
    this.rejectPending(new Error("SDK worker is stopping"));
    try {
      if (this.child.pid) await killProcessTree(this.child.pid, { graceMs: input.forceAfterMs ?? SESSION_STOP_GRACE_MS });
      else if (!this.exited) this.child.kill("SIGTERM");
    } finally { rmSync(this.directory, { recursive: true, force: true }); }
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded || this.child.stdin.writable === false) {
      return Promise.reject(new Error("SDK worker stdin is unavailable"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`SDK ${method} did not acknowledge before its deadline`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        const line = JSON.stringify({ id, method, params });
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("SDK worker input exceeds its protocol limit");
        this.child.stdin!.write(`${line}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.protocolFailure(); return; }
      try {
        const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { code?: string; message?: string }; event?: SdkWorkerEvent };
        if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.error) {
            const code = frame.error.code;
            const message = scrubDriverErrorMessage(frame.error.message);
            pending.reject(code === "reset_required" || code === "incompatible_configuration" || code === "authentication_required" || code === "runtime_busy"
              ? new SdkRequestError(code, message) : new Error(message));
          } else pending.resolve(frame.result);
        } else if (frame.event && typeof frame.event.kind === "string") {
          if (frame.event.kind === "worker_error") { this.protocolFailure(frame.event.message); return; }
          if (frame.event.kind === "session_init") this.sessionId = frame.event.sessionId;
          if (frame.event.kind === "error" || frame.event.kind === "runtime_diagnostic") frame.event.message = scrubDriverErrorMessage(frame.event.message);
          this.events.emit("runtime_event", frame.event);
        }
      } catch { this.protocolFailure(); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.protocolFailure();
  }

  private protocolFailure(message = "SDK worker emitted an invalid or oversized protocol frame"): void {
    this.buffer = "";
    const error = new Error(scrubDriverErrorMessage(message));
    this.rejectPending(error);
    this.events.emit("error", error);
    void this.stop({ reason: "protocol_error", forceAfterMs: 0 }).catch(() => {});
  }

  private rejectPending(error: unknown): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
