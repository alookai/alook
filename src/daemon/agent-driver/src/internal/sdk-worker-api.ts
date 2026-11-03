import type { AdapterEvent, LaneAdmission, LaneSendInput, ProbeResult } from "./adapter.js";

export type SdkWorkerEvent = AdapterEvent | { readonly kind: "worker_error"; readonly code: string; readonly message: string };

export interface SdkWorkerInit {
  readonly moduleUrl: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly instructions?: string;
  readonly config: {
    readonly model?: string;
    readonly command?: string;
    readonly reasoningEffort?: string;
    readonly provider?: { readonly kind: string; readonly providerId?: string; readonly apiKey?: string };
  };
  readonly probe?: { readonly includeModels: boolean };
}

export interface SdkWorkerSession {
  readonly sessionId: string;
  send(input: LaneSendInput): Promise<LaneAdmission>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
}

export type SdkWorkerFactory = (
  init: SdkWorkerInit,
  emit: (event: SdkWorkerEvent) => void,
) => Promise<SdkWorkerSession | ProbeResult>;

export async function sdkWorkerMain(factory: SdkWorkerFactory): Promise<void> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("node:readline")>;
  const { createInterface } = await load("node:readline");
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const send = (message: unknown): void => { write(`${JSON.stringify(message)}\n`); };
  let session: SdkWorkerSession | undefined;
  let closing = false;
  let opening: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await opening?.catch(() => {});
    await session?.close();
  };
  const fail = (id: number, error: unknown): void => {
    const value = error as { code?: unknown; message?: unknown } | undefined;
    send({ id, error: {
      code: typeof value?.code === "string" ? value.code : "sdk_request_failed",
      message: error instanceof Error ? error.message : "SDK request failed",
    } });
  };
  const request = async (frame: { id: number; method: string; params: unknown }): Promise<void> => {
    try {
      if (frame.method === "open") {
        if (opening || session || closing) throw new Error("SDK worker was already opened or stopped");
        opening = (async () => {
          const init = frame.params as SdkWorkerInit;
          const result = await factory(init, (event) => send({ event }));
          if ("status" in result) {
            send({ id: frame.id, result });
            return;
          }
          session = result;
          send({ event: { kind: "session_init", sessionId: result.sessionId } });
          send({ id: frame.id, result: { sessionId: result.sessionId } });
        })();
        await opening;
        return;
      }
      if (frame.method === "close") {
        await close();
        send({ id: frame.id, result: null });
        return;
      }
      if (closing || !session) throw new Error("SDK worker is not open");
      if (frame.method === "send") send({ id: frame.id, result: await session.send(frame.params as LaneSendInput) });
      else if (frame.method === "interrupt") send({ id: frame.id, result: await session.interrupt() });
      else throw new Error("Unknown SDK worker request");
    } catch (error) { fail(frame.id, error); }
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line: string) => {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) { process.exitCode = 1; lines.close(); return; }
    try {
      const frame = JSON.parse(line) as { id: number; method: string; params: unknown };
      if (!Number.isSafeInteger(frame.id) || typeof frame.method !== "string") throw new Error("Invalid request");
      void request(frame);
    } catch { process.exitCode = 1; lines.close(); }
  });
  lines.on("close", () => { void close().finally(() => process.exit(process.exitCode ?? 0)); });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { void close().finally(() => process.exit(0)); });
  }
}
