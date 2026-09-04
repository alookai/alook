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
  finish(result: Result): void;
  fail(message: string): void;
  flushStdout(): void;
  write(line: string): void;
}

interface DiscoveryProcessOptions<Result> {
  readonly process: SpawnedProcessHandle;
  readonly label: string;
  readonly timeoutMs: number;
  readonly outputMaxBytes: number;
  readonly cleanup?: DiscoveryProcessDependencies["cleanup"];
  readonly exitEvent: "exit" | "close";
  readonly onStdout: (text: string, final: boolean, control: DiscoveryProcessControl<Result>) => void;
  readonly onExit: (code: number | null, signal: string | null, control: DiscoveryProcessControl<Result>) => void;
  readonly onStart?: (control: DiscoveryProcessControl<Result>) => void;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

async function cleanupProcess(process: SpawnedProcessHandle, label: string): Promise<void> {
  if (process.pid) await killProcessTree(process.pid, { graceMs: 250 });
  else if (process.exitCode === null && process.signalCode === null && !process.kill("SIGTERM")) {
    throw new Error(`${label} discovery cleanup failed`);
  }
}

function onStream(stream: unknown, event: "error" | "end", listener: () => void): void {
  (stream as { on?: (event: string, listener: () => void) => unknown } | undefined)?.on?.(event, listener);
}

export function runBoundedDiscoveryProcess<Result>(options: DiscoveryProcessOptions<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let settled = false;
    let decoderEnded = false;
    let outputBytes = 0;
    const settle = (result?: Result, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!decoderEnded) decoder.end();
      void Promise.resolve().then(
        () => options.cleanup?.(options.process) ?? cleanupProcess(options.process, options.label),
      ).then(
        () => error ? reject(error) : resolve(result as Result),
        () => reject(error ?? new Error(`${options.label} discovery cleanup failed`)),
      );
    };
    const control: DiscoveryProcessControl<Result> = {
      get outputBytes() { return outputBytes; },
      finish: (result) => settle(result),
      fail: (message) => settle(undefined, new Error(message)),
      flushStdout: () => {
        if (settled || decoderEnded) return;
        decoderEnded = true;
        options.onStdout(decoder.end(), true, control);
      },
      write: (line) => {
        const stdin = options.process.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
          return control.fail(`${options.label} discovery transport is unavailable`);
        }
        try { stdin.write(line); } catch { control.fail(`${options.label} discovery transport write failed`); }
      },
    };
    const addBytes = (chunk: unknown, decode: boolean) => {
      if (settled) return;
      const bytes = toBuffer(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > options.outputMaxBytes) {
        control.fail(`${options.label} discovery output exceeded its bound`);
      } else if (decode) options.onStdout(decoder.write(bytes), false, control);
    };
    const timer = setTimeout(
      () => control.fail(`${options.label} discovery timed out`),
      Math.max(1, options.timeoutMs),
    );
    timer.unref?.();
    options.process.stdout?.on("data", (chunk) => addBytes(chunk, true));
    options.process.stderr?.on("data", (chunk) => addBytes(chunk, false));
    onStream(options.process.stdout, "end", control.flushStdout);
    for (const stream of [options.process.stdin, options.process.stdout, options.process.stderr]) {
      onStream(stream, "error", () => control.fail(`${options.label} discovery transport failed`));
    }
    options.process.on("error", () => control.fail(`${options.label} discovery process failed`));
    options.process.on(options.exitEvent, (code, signal) => options.onExit(code, signal, control));
    options.onStart?.(control);
  });
}
