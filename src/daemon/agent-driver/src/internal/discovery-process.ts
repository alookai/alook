import { StringDecoder } from "node:string_decoder";
import type { SpawnedProcessHandle } from "./adapter.js";
import { killProcessTree } from "./killTree.js";

export type DiscoverySpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean; stdin?: "ignore" },
) => SpawnedProcessHandle;

export interface DiscoveryProcessDependencies {
  readonly spawn?: DiscoverySpawn;
  readonly cleanup?: (process: SpawnedProcessHandle) => Promise<void>;
  readonly timeoutMs?: number;
  readonly outputMaxBytes?: number;
  readonly cwd?: string;
}

export interface DiscoveryProcessControl<Result> {
  readonly outputBytes: number;
  readonly settled: boolean;
  finish(result: Result): void;
  fail(message: string): void;
  flushStdout(): void;
  flushStderr(): void;
  write(line: string): void;
}

interface DiscoveryProcessOptions<Result> {
  readonly process: SpawnedProcessHandle;
  readonly label: string;
  readonly timeoutMs: number;
  readonly outputMaxBytes: number;
  readonly cleanup?: DiscoveryProcessDependencies["cleanup"];
  readonly cleanupGraceMs?: number;
  readonly stderr?: "count" | "ignore";
  readonly exitEvent: "exit" | "close";
  readonly onStdout: (text: string, final: boolean, control: DiscoveryProcessControl<Result>) => void;
  readonly onStderr?: (text: string, final: boolean, control: DiscoveryProcessControl<Result>) => void;
  readonly onExit: (code: number | null, signal: string | null, control: DiscoveryProcessControl<Result>) => void;
  readonly onStart?: (control: DiscoveryProcessControl<Result>) => void;
}

export class DiscoveryProcessError extends Error {
  constructor(readonly code: "timeout" | "output_limit" | "transport_unavailable" | "write_failed" | "transport_failed" | "process_failed" | "request_failed" | "cleanup_failed", message: string, readonly cleanupFailed = false) {
    super(message);
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

async function cleanupProcess(process: SpawnedProcessHandle, label: string, graceMs: number): Promise<void> {
  if (process.pid) await killProcessTree(process.pid, { graceMs });
  else if (process.exitCode === null && process.signalCode === null && !process.kill("SIGTERM")) {
    throw new DiscoveryProcessError("cleanup_failed", `${label} discovery cleanup failed`);
  }
}

function onStream(stream: unknown, event: "error" | "end", listener: () => void): void {
  (stream as { on?: (event: string, listener: () => void) => unknown } | undefined)?.on?.(event, listener);
}

export function runBoundedDiscoveryProcess<Result>(options: DiscoveryProcessOptions<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    let decoderEnded = false;
    let stderrEnded = false;
    let outputBytes = 0;
    const settle = (result?: Result, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!decoderEnded) decoder.end();
      if (!stderrEnded) stderrDecoder.end();
      void Promise.resolve().then(
        () => options.cleanup?.(options.process) ?? cleanupProcess(options.process, options.label, options.cleanupGraceMs ?? 250),
      ).then(
        () => error ? reject(error) : resolve(result as Result),
        () => reject(new DiscoveryProcessError(
          error instanceof DiscoveryProcessError ? error.code : error ? "request_failed" : "cleanup_failed",
          error?.message ?? `${options.label} discovery cleanup failed`,
          true,
        )),
      );
    };
    const control: DiscoveryProcessControl<Result> = {
      get outputBytes() { return outputBytes; },
      get settled() { return settled; },
      finish: (result) => settle(result),
      fail: (message) => settle(undefined, new Error(message)),
      flushStdout: () => {
        if (settled || decoderEnded) return;
        decoderEnded = true;
        options.onStdout(decoder.end(), true, control);
      },
      flushStderr: () => {
        if (settled || stderrEnded) return;
        stderrEnded = true;
        options.onStderr?.(stderrDecoder.end(), true, control);
      },
      write: (line) => {
        if (settled) return;
        const stdin = options.process.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
          return settle(undefined, new DiscoveryProcessError("transport_unavailable", `${options.label} discovery transport is unavailable`));
        }
        try { stdin.write(line); } catch { settle(undefined, new DiscoveryProcessError("write_failed", `${options.label} discovery transport write failed`)); }
      },
    };
    const observe = (callback: () => void) => {
      if (settled) return;
      try { callback(); }
      catch { settle(undefined, new DiscoveryProcessError("process_failed", `${options.label} discovery callback failed`)); }
    };
    const addBytes = (chunk: unknown, stream: "stdout" | "stderr") => {
      if (settled) return;
      if (stream === "stderr" && options.stderr === "ignore") return;
      const bytes = toBuffer(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > options.outputMaxBytes) {
        settle(undefined, new DiscoveryProcessError("output_limit", `${options.label} discovery output exceeded its bound`));
      } else if (stream === "stdout") observe(() => options.onStdout(decoder.write(bytes), false, control));
      else if (options.onStderr) observe(() => options.onStderr?.(stderrDecoder.write(bytes), false, control));
    };
    const timer = setTimeout(
      () => settle(undefined, new DiscoveryProcessError("timeout", `${options.label} discovery timed out`)),
      Math.max(1, options.timeoutMs),
    );
    timer.unref?.();
    options.process.stdout?.on("data", (chunk) => addBytes(chunk, "stdout"));
    options.process.stderr?.on("data", (chunk) => addBytes(chunk, "stderr"));
    onStream(options.process.stdout, "end", () => observe(control.flushStdout));
    onStream(options.process.stderr, "end", () => observe(control.flushStderr));
    for (const stream of [options.process.stdin, options.process.stdout, options.process.stderr]) {
      onStream(stream, "error", () => settle(undefined, new DiscoveryProcessError("transport_failed", `${options.label} discovery transport failed`)));
    }
    options.process.on("error", () => settle(undefined, new DiscoveryProcessError("process_failed", `${options.label} discovery process failed`)));
    options.process.on(options.exitEvent, (code, signal) => observe(() => options.onExit(code, signal, control)));
    observe(() => options.onStart?.(control));
  });
}
